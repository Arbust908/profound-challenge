import { useState, useCallback, useRef, useEffect } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { useNavigate } from '@tanstack/react-router'
import { createSession } from '~/server/sessions'
import type { Session } from '~/types/session'
import { sessionKeys } from './use-sessions'

function isValidUrl(url: string): boolean {
  try {
    new URL(url)
    return true
  } catch {
    return false
  }
}

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

  // Abort any in-flight request when the component unmounts
  useEffect(() => {
    return () => { abortRef.current?.abort() }
  }, [])

  const summarize = useCallback(async (url: string) => {
    // Abort any in-flight stream before starting a new one
    abortRef.current?.abort()
    const controller = new AbortController()
    abortRef.current = controller

    // Client-side guard — server also validates but this gives a user-friendly message
    if (!isValidUrl(url)) {
      setState({ status: 'error', message: 'Invalid URL' })
      return
    }

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
      if (!res.body) throw new Error('Response body is null')
      const reader = res.body.getReader()
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
      const cached: Session = {
        id: session.id,
        url: session.url,
        title: session.title,
        error: session.error,
        created_at: session.created_at,
        updated_at: session.updated_at,
        summary: accumulated,
        status: 'done',
      }
      queryClient.setQueryData(sessionKeys.detail(session.id), cached)

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
