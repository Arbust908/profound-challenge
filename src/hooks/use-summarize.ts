import { useState, useCallback, useRef } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { useNavigate } from '@tanstack/react-router'
import { createSession } from '~/server/sessions'
import { sessionKeys } from './use-sessions'

export type SummarizeState =
  | { status: 'idle' }
  | { status: 'creating' }
  | { status: 'streaming'; sessionId: string; content: string }
  | { status: 'done'; sessionId: string }
  | { status: 'error'; message: string }

export function useSummarize() {
  const [state, setState] = useState<SummarizeState>({ status: 'idle' })
  const queryClient = useQueryClient()
  const navigate = useNavigate()
  // Ref so abort() can be called from reset() or on unmount without stale closures
  const abortRef = useRef<AbortController | null>(null)

  const summarize = useCallback(async (url: string) => {
    // Abort any in-flight stream before starting a new one
    abortRef.current?.abort()
    const controller = new AbortController()
    abortRef.current = controller

    setState({ status: 'creating' })

    try {
      // 1. Create the session row — sidebar does NOT update yet
      const session = await createSession({ data: { url } })

      setState({ status: 'streaming', sessionId: session.id, content: '' })

      // 2. Kick off the streaming request, wired to the abort signal
      const res = await fetch('/api/summarize', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId: session.id }),
        signal: controller.signal,
      })

      if (!res.ok) {
        const err = await res.json()
        throw new Error(err.error ?? 'Summarization failed')
      }

      // 3. Read the stream
      const reader = res.body!.getReader()
      const decoder = new TextDecoder()
      let accumulated = ''

      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        accumulated += decoder.decode(value, { stream: true })
        setState({ status: 'streaming', sessionId: session.id, content: accumulated })
      }

      // 4. Seed the TanStack Query cache with completed content BEFORE navigating
      //    so the session detail route renders instantly with no flicker
      queryClient.setQueryData(sessionKeys.detail(session.id), {
        ...session,
        summary: accumulated,
        status: 'done' as const,
      })

      setState({ status: 'done', sessionId: session.id })

      // 5. Navigate to the completed session — cache is warm, no skeleton flash
      navigate({ to: '/sessions/$id', params: { id: session.id } })

    } catch (err) {
      // DOMException with name 'AbortError' means the user deliberately cancelled
      if ((err as Error).name === 'AbortError') return
      setState({ status: 'error', message: (err as Error).message })
    } finally {
      // 6. Invalidate AFTER stream ends (success OR error) so sidebar updates once
      queryClient.invalidateQueries({ queryKey: sessionKeys.all })
    }
  }, [queryClient, navigate])

  const reset = useCallback(() => {
    abortRef.current?.abort()
    setState({ status: 'idle' })
  }, [])

  return { state, summarize, reset }
}
