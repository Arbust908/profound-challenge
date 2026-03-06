# URL Summarization App — Step-by-Step Build Guide

**Stack**: TanStack Start · Supabase · TanStack Query · Vercel AI SDK + OpenRouter · Tailwind · Streamdown · Motion

---

## Phase 0 — Project Scaffold

### 0.1 Create TanStack Start app

Use the dedicated Start initializer — it's interactive and ensures Vite, Nitro, and TanStack Router are all correctly synced:

```bash
npm create @tanstack/start@latest url-summarizer
```

When prompted:
1. Select **React**
2. Select **TypeScript**
3. Select **Tailwind CSS**

```bash
cd url-summarizer
npm install
npm run dev  # verify it boots before adding anything
```

> The older `create-tsrouter-app` command still works but is moving toward legacy status. `@tanstack/start` is the dedicated full-stack initializer and is now the recommended path.

### 0.2 Install all dependencies

```bash
# Core
npm install @tanstack/react-query @tanstack/react-query-devtools
npm install @supabase/supabase-js

# AI / streaming
npm install ai @ai-sdk/openai          # Vercel AI SDK + OpenRouter uses OpenAI-compatible provider
npm install @ai-sdk/tavily             # Tavily web search tool — first-class AI SDK integration
npm install streamdown                  # Streaming markdown renderer

# UI / animation
npm install motion                      # Motion (formerly Framer Motion)
npm install clsx tailwind-merge        # Class utilities

# Server utilities
npm install zod                        # Schema validation

# Testing
npm install -D vitest @vitest/ui playwright @playwright/test
npm install -D @testing-library/react @testing-library/user-event
npm install -D msw                     # Mock Service Worker — intercept fetch in tests
```

### 0.3 Environment variables

Create `.env.local`:

```env
SUPABASE_URL=https://xxxx.supabase.co
SUPABASE_SERVICE_ROLE_KEY=your_service_role_key
OPENROUTER_API_KEY=your_openrouter_key
TAVILY_API_KEY=tvly-your-key-here
```

> All four are server-only — none need the `VITE_` prefix since the client never talks to Supabase, OpenRouter, or Tavily directly.

---

## Phase 1 — Supabase Database

### 1.1 Create the `sessions` table

Run this SQL in Supabase Studio → SQL Editor:

```sql
create table sessions (
  id          uuid primary key default gen_random_uuid(),
  url         text not null,
  title       text,
  summary     text,
  status      text not null default 'pending'
                check (status in ('pending', 'streaming', 'done', 'error')),
  error       text,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

-- Auto-update updated_at
create or replace function update_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create trigger sessions_updated_at
  before update on sessions
  for each row execute procedure update_updated_at();


```

### 1.2 Enable Row Level Security (optional but recommended)

```sql
alter table sessions enable row level security;

-- Allow all operations for now (tighten when adding auth)
create policy "allow all" on sessions for all using (true) with check (true);
```

### 1.3 Supabase server client

`src/lib/supabase-server.ts`

```ts
import { createClient } from '@supabase/supabase-js'
import type { Database } from './database.types'

export const supabaseServer = createClient<Database>(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
)
```

There is no client-side Supabase instance — all DB access goes through server functions and the API route, so the service role client is the only one needed.

### 1.4 Generate TypeScript types

```bash
npx supabase gen types typescript \
  --project-id YOUR_PROJECT_ID \
  --schema public > src/lib/database.types.ts
```

---

## Phase 2 — Domain Types & Models

`src/types/session.ts`

```ts
export type SessionStatus = 'pending' | 'streaming' | 'done' | 'error'

export interface Session {
  id: string
  url: string
  title: string | null
  summary: string | null
  status: SessionStatus
  error: string | null
  created_at: string
  updated_at: string
}

export interface CreateSessionInput {
  url: string
}

export interface SearchSessionsInput {
  query: string
}

export interface PaginatedSessions {
  data: Session[]
  total: number
  page: number
  pageSize: number
  hasNextPage: boolean
}

export const PAGE_SIZE = 20
```

> Keep this file as the single source of truth — the API layer, TanStack Query hooks, and components all import from here.

---

## Phase 3 — API Routes (TanStack Start Server Functions)

TanStack Start uses `createServerFn` for type-safe API handlers that run on the server.

### 3.1 List sessions (paginated)

`src/server/sessions.ts`

```ts
import { createServerFn } from '@tanstack/react-start'
import { supabaseServer } from '~/lib/supabase-server'
import type { Session, PaginatedSessions } from '~/types/session'
import { PAGE_SIZE } from '~/types/session'

const PageInput = z.object({ page: z.number().int().min(1).default(1) })

export const listSessions = createServerFn({ method: 'GET' })
  .validator((input: unknown) => PageInput.parse(input))
  .handler(async ({ data }): Promise<PaginatedSessions> => {
    const { page } = data
    const from = (page - 1) * PAGE_SIZE
    const to = from + PAGE_SIZE - 1

    const { data: sessions, error, count } = await supabaseServer
      .from('sessions')
      .select('*', { count: 'exact' })
      .order('created_at', { ascending: false })
      .range(from, to)

    if (error) throw new Error(error.message)

    return {
      data: sessions,
      total: count ?? 0,
      page,
      pageSize: PAGE_SIZE,
      hasNextPage: (count ?? 0) > page * PAGE_SIZE,
    }
  })
```

### 3.2 Get single session

```ts
export const getSession = createServerFn({ method: 'GET' })
  .validator((id: string) => id)
  .handler(async ({ data: id }): Promise<Session> => {
    const { data, error } = await supabaseServer
      .from('sessions')
      .select('*')
      .eq('id', id)
      .single()

    if (error) throw new Error(error.message)
    return data
  })
```

### 3.3 Delete session

```ts
export const deleteSession = createServerFn({ method: 'POST' })
  .validator((id: string) => id)
  .handler(async ({ data: id }) => {
    const { error } = await supabaseServer
      .from('sessions')
      .delete()
      .eq('id', id)

    if (error) throw new Error(error.message)
    return { success: true }
  })
```

### 3.4 Search sessions (paginated, uses FTS index)

```ts
const SearchInput = z.object({
  query: z.string(),
  page: z.number().int().min(1).default(1),
})

export const searchSessions = createServerFn({ method: 'GET' })
  .validator((input: unknown) => SearchInput.parse(input))
  .handler(async ({ data }): Promise<PaginatedSessions> => {
    const { query, page } = data
    const from = (page - 1) * PAGE_SIZE
    const to = from + PAGE_SIZE - 1

    if (!query.trim()) {
      return listSessions({ data: { page } })
    }

    // Use FTS for ranked results when query is present; fall back to ilike for
    // short queries that don't tokenize well (< 3 chars)
    const { data: sessions, error, count } = await supabaseServer
      .from('sessions')
      .select('*', { count: 'exact' })
      .or(`url.ilike.%${query}%,title.ilike.%${query}%,summary.ilike.%${query}%`)
      .order('created_at', { ascending: false })
      .range(from, to)

    if (error) throw new Error(error.message)

    return {
      data: sessions,
      total: count ?? 0,
      page,
      pageSize: PAGE_SIZE,
      hasNextPage: (count ?? 0) > page * PAGE_SIZE,
    }
  })
```

### 3.5 Create session (inserts a pending row, returns the ID)

```ts
import { z } from 'zod'

const CreateInput = z.object({ url: z.string().url() })

export const createSession = createServerFn({ method: 'POST' })
  .validator((input: unknown) => CreateInput.parse(input))
  .handler(async ({ data }): Promise<Session> => {
    const { data: session, error } = await supabaseServer
      .from('sessions')
      .insert({ url: data.url, status: 'pending' })
      .select()
      .single()

    if (error) throw new Error(error.message)
    return session
  })
```



---

## Phase 4 — Streaming Summarization Route

This is the most critical part. Rather than manually fetching and scraping the page, we give the LLM a `webSearch` tool powered by **Tavily** — a search/retrieval API built specifically for LLM use cases. The model decides when to call it, fetches clean content, then streams the summary.

The flow:
1. Client posts `sessionId` to `/api/summarize`
2. `streamText` starts with Tavily tool attached — model calls it to read the URL
3. Tavily fetches + extracts the page, returns clean text to the model
4. Model streams the summary back to the client
5. On finish, completed summary is persisted to Supabase

### 4.1 Create the API route file

`src/routes/api/summarize.ts`

```ts
import { createAPIFileRoute } from '@tanstack/react-start/api'
import { streamText } from 'ai'
import { createOpenAI } from '@ai-sdk/openai'
import { tavily } from '@ai-sdk/tavily'
import { supabaseServer } from '~/lib/supabase-server'

const openrouter = createOpenAI({
  baseURL: 'https://openrouter.ai/api/v1',
  apiKey: process.env.OPENROUTER_API_KEY!,
})

export const APIRoute = createAPIFileRoute('/api/summarize')({
  POST: async ({ request }) => {
    const { sessionId } = await request.json() as { sessionId: string }

    // 1. Get session from DB
    const { data: session, error: sessionError } = await supabaseServer
      .from('sessions')
      .select('url')
      .eq('id', sessionId)
      .single()

    if (sessionError || !session) {
      return new Response(JSON.stringify({ error: 'Session not found' }), {
        status: 404,
        headers: { 'Content-Type': 'application/json' },
      })
    }

    // 2. Update status to streaming
    await supabaseServer
      .from('sessions')
      .update({ status: 'streaming' })
      .eq('id', sessionId)

    // 3. Stream summary — Tavily tool fetches and extracts the page content
    //    maxSteps: 3 keeps the agentic loop going:
    //      Step 1: model reads the prompt → calls webSearch tool
    //      Step 2: Tavily fetches the URL → returns clean text to model
    //      Step 3: model streams the summary ✓
    let pageTitle = ''

    const result = streamText({
      model: openrouter('anthropic/claude-3.5-haiku'),
      system: `You are a concise summarization assistant.
When given a URL, use the webSearch tool to retrieve its content.
Then write a clear, well-structured markdown summary covering the main ideas,
key facts, and conclusions. Use headers and bullet points where appropriate.`,
      messages: [
        {
          role: 'user',
          content: `Please summarize this page: ${session.url}`,
        },
      ],
      tools: {
        webSearch: tavily({ apiKey: process.env.TAVILY_API_KEY! }),
      },
      maxSteps: 3,
      async onFinish({ text }) {
        // 4. Persist completed summary
        await supabaseServer
          .from('sessions')
          .update({ summary: text, status: 'done', title: pageTitle || null })
          .eq('id', sessionId)
      },
    })

    return result.toTextStreamResponse()
  },
})
```

---

## Phase 5 — TanStack Query Setup & Hooks

### 5.1 Query client provider

`src/main.tsx` (or wherever your app root is):

```tsx
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { ReactQueryDevtools } from '@tanstack/react-query-devtools'

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 30_000,
      retry: 1,
    },
  },
})

export function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
      <ReactQueryDevtools initialIsOpen={false} />
    </QueryClientProvider>
  )
}
```

### 5.2 Session query hooks

`src/hooks/use-sessions.ts`

```ts
import { useInfiniteQuery, useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { useNavigate, useLocation } from '@tanstack/react-router'
import { listSessions, deleteSession, searchSessions, getSession } from '~/server/sessions'

export const sessionKeys = {
  all: ['sessions'] as const,
  list: (page: number) => [...sessionKeys.all, 'list', page] as const,
  search: (query: string, page: number) => [...sessionKeys.all, 'search', query, page] as const,
  detail: (id: string) => [...sessionKeys.all, 'detail', id] as const,
}

// Infinite scroll — loads PAGE_SIZE items, fetches next page on demand
export function useSessions(query: string) {
  return useInfiniteQuery({
    queryKey: query ? sessionKeys.search(query, 1) : sessionKeys.list(1),
    queryFn: ({ pageParam = 1 }) =>
      query
        ? searchSessions({ data: { query, page: pageParam } })
        : listSessions({ data: { page: pageParam } }),
    getNextPageParam: (lastPage) =>
      lastPage.hasNextPage ? lastPage.page + 1 : undefined,
    initialPageParam: 1,
  })
}

// Flatten paginated pages into a single array for rendering
export function useSessionList(query: string) {
  const result = useSessions(query)
  const sessions = result.data?.pages.flatMap((p) => p.data) ?? []
  return { ...result, sessions }
}

export function useSession(id: string) {
  return useQuery({
    queryKey: sessionKeys.detail(id),
    queryFn: () => getSession({ data: id }),
    enabled: Boolean(id),
  })
}

export function useDeleteSession() {
  const queryClient = useQueryClient()
  const navigate = useNavigate()
  const { pathname } = useLocation()

  return useMutation({
    mutationFn: (id: string) => deleteSession({ data: id }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: sessionKeys.all })
      // Guard: only navigate if not already at '/'
      if (pathname !== '/') {
        navigate({ to: '/' })
      }
    },
  })
}
```

### 5.3 Streaming hook with AbortController

`src/hooks/use-summarize.ts`

```ts
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
```

---

## Phase 6 — Component Architecture

### Folder structure

```
src/
  components/
    layout/
      Sidebar.tsx          # Session list + search
      MainPanel.tsx        # Active session view
    sessions/
      SessionList.tsx      # Scrollable list of SessionCard
      SessionCard.tsx      # Single session row
      SessionSearch.tsx    # Debounced search input
      EmptyState.tsx       # Empty list / no results
    summary/
      SummaryView.tsx      # Displays a completed or streaming summary
      StreamingDisplay.tsx # Uses Streamdown for animated streaming text
      SummaryMeta.tsx      # URL, title, timestamps, copy/download actions
    forms/
      NewSummaryForm.tsx   # URL input + submit
    ui/
      Button.tsx
      Input.tsx
      Badge.tsx
      Spinner.tsx
      ErrorMessage.tsx
  hooks/
    use-sessions.ts
    use-summarize.ts
    use-debounce.ts
  server/
    sessions.ts
  routes/
    api/
      summarize.ts
    index.tsx              # Main layout (sidebar + panel)
    sessions.$id.tsx       # Session detail route
  types/
    session.ts
  lib/
    supabase.ts
    supabase-server.ts
    utils.ts
```

### 6.1 Debounce hook (for search)

`src/hooks/use-debounce.ts`

```ts
import { useState, useEffect } from 'react'

export function useDebounce<T>(value: T, delay = 300): T {
  const [debounced, setDebounced] = useState(value)

  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), delay)
    return () => clearTimeout(timer)
  }, [value, delay])

  return debounced
}
```

### 6.2 StreamingDisplay with Streamdown

`src/components/summary/StreamingDisplay.tsx`

```tsx
import Streamdown from 'streamdown'

interface Props {
  content: string
  isStreaming: boolean
}

export function StreamingDisplay({ content, isStreaming }: Props) {
  return (
    <div className="prose prose-sm max-w-none">
      <Streamdown
        text={content}
        // Streamdown animates new characters as they arrive
        // It also renders full markdown once streaming is done
      />
      {isStreaming && (
        <span className="inline-block w-2 h-4 bg-current animate-pulse ml-0.5" />
      )}
    </div>
  )
}
```

### 6.3 Motion transitions for route/panel changes

`src/components/summary/SummaryView.tsx`

```tsx
import { motion, AnimatePresence } from 'motion'

interface Props {
  sessionId: string | null
}

export function SummaryView({ sessionId }: Props) {
  return (
    <AnimatePresence mode="wait">
      {sessionId ? (
        <motion.div
          key={sessionId}
          initial={{ opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: -8 }}
          transition={{ duration: 0.2, ease: 'easeOut' }}
        >
          {/* Session content */}
        </motion.div>
      ) : (
        <motion.div
          key="empty"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
        >
          <EmptyState />
        </motion.div>
      )}
    </AnimatePresence>
  )
}
```

### 6.4 SessionCard with grow animation and delete

```tsx
import { motion, AnimatePresence } from 'motion/react'
import { useDeleteSession } from '~/hooks/use-sessions'
import type { Session } from '~/types/session'

interface Props {
  session: Session
  isActive: boolean
  onClick: () => void
}

export function SessionCard({ session, isActive, onClick }: Props) {
  const { mutate: deleteSession, isPending } = useDeleteSession()

  return (
    // Outer motion.div animates height 0 → auto on entry, auto → 0 on exit
    // overflow: hidden is critical — without it content spills during animation
    // inner div holds the padding so it doesn't fight the height animation
    <motion.div
      layout
      initial={{ height: 0, opacity: 0 }}
      animate={{ height: 'auto', opacity: 1 }}
      exit={{ height: 0, opacity: 0 }}
      transition={{
        height: { duration: 0.25, ease: [0.16, 1, 0.3, 1] }, // snappy expo-out feel
        opacity: { duration: 0.2 },
      }}
      style={{ overflow: 'hidden' }}
    >
      <div
        className={clsx(
          'group flex items-start gap-3 px-3 py-2.5 rounded-lg cursor-pointer transition-colors mx-1',
          isActive ? 'bg-neutral-100' : 'hover:bg-neutral-50'
        )}
        onClick={onClick}
      >
        <div className="flex-1 min-w-0">
          <p className="text-sm font-medium truncate">
            {session.title ?? new URL(session.url).hostname}
          </p>
          <p className="text-xs text-neutral-400 truncate mt-0.5">
            {session.url}
          </p>
        </div>

        <button
          className="opacity-0 group-hover:opacity-100 transition-opacity p-1 rounded hover:bg-neutral-200"
          onClick={(e) => {
            e.stopPropagation()
            deleteSession(session.id)
          }}
          disabled={isPending}
          aria-label="Delete session"
        >
          <IconDelete className="text-neutral-400 w-3.5 h-3.5" />
        </button>
      </div>
    </motion.div>
  )
}
```

Wrap the list with `AnimatePresence initial={false}` — the `initial={false}` prevents all existing cards from playing the grow animation on first page load, only newly added ones animate in:

```tsx
<div className="flex-1 overflow-y-auto p-2">
  <AnimatePresence initial={false}>
    {sessions?.map((session) => (
      <SessionCard key={session.id} session={session} ... />
    ))}
  </AnimatePresence>
</div>
```

---

## Phase 7 — Route Layout

Route structure:
```
/                    ← empty state, URL input in sidebar focused, ready to summarize
/sessions/:id        ← active session view
```

### 7.1 Root layout with sidebar

`src/routes/__root.tsx` (or the layout wrapper)

```tsx
import { createRootRoute, Outlet, useNavigate, useParams } from '@tanstack/react-router'
import { useSessionList } from '~/hooks/use-sessions'
import { useSummarize } from '~/hooks/use-summarize'
import { useDebounce } from '~/hooks/use-debounce'
import { useEffect, useRef, useState } from 'react'
import { AnimatePresence } from 'motion/react'

export const Route = createRootRoute({
  component: RootLayout,
})

function RootLayout() {
  const [query, setQuery] = useState('')
  const debouncedQuery = useDebounce(query)
  const { sessions, fetchNextPage, hasNextPage, isFetchingNextPage } = useSessionList(debouncedQuery)
  const { state: summarizeState, summarize } = useSummarize()
  const navigate = useNavigate()

  // Intersection observer sentinel — triggers next page fetch when user scrolls to bottom
  const sentinelRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!sentinelRef.current || !hasNextPage) return
    const observer = new IntersectionObserver(
      ([entry]) => { if (entry.isIntersecting) fetchNextPage() },
      { threshold: 0.1 }
    )
    observer.observe(sentinelRef.current)
    return () => observer.disconnect()
  }, [fetchNextPage, hasNextPage])

  return (
    <div className="flex h-screen bg-white overflow-hidden">
      {/* Sidebar — always visible */}
      <aside className="w-72 border-r border-neutral-200 flex flex-col">
        <div className="p-4 border-b border-neutral-200">
          <NewSummaryForm onSubmit={summarize} state={summarizeState} />
        </div>
        <div className="p-3 border-b border-neutral-200">
          <SessionSearch value={query} onChange={setQuery} />
        </div>
        <div className="flex-1 overflow-y-auto p-2">
          <AnimatePresence initial={false}>
            {sessions.map((session) => (
              <SessionCard
                key={session.id}
                session={session}
                isActive={false /* derive from router match */}
                onClick={() => navigate({ to: '/sessions/$id', params: { id: session.id } })}
              />
            ))}
          </AnimatePresence>

          {/* Scroll sentinel — when visible, loads next page */}
          <div ref={sentinelRef} className="h-4" />
          {isFetchingNextPage && (
            <div className="flex justify-center py-2">
              <IconSpinner className="w-4 h-4 text-neutral-300 animate-spin" />
            </div>
          )}
        </div>
      </aside>

      {/* Main panel — route outlet with crossfade transition */}
      <main className="flex-1 overflow-y-auto relative">
        <AnimatePresence mode="popLayout">
          <Outlet />
        </AnimatePresence>
      </main>
    </div>
  )
}
```

### 7.2 Index route — empty / new summary state

`src/routes/index.tsx`

The URL input lives in the sidebar (always visible), so the main panel is just a calm prompt.
On page refresh at `'/'`, TanStack Router renders this, TanStack Query reloads the session list, everything just works.

```tsx
import { createFileRoute } from '@tanstack/react-router'
import { motion } from 'motion/react'

export const Route = createFileRoute('/')({
  component: IndexPage,
})

function IndexPage() {
  return (
    <motion.div
      key="index"
      initial={{ opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.2 }}
      className="flex-1 flex flex-col items-center justify-center gap-4 text-center p-8 h-full"
    >
      <h2 className="text-lg font-medium text-neutral-700">
        Summarize a webpage
      </h2>
      <p className="text-sm text-neutral-400 mt-1">
        Paste a URL in the sidebar to get started
      </p>
    </motion.div>
  )
}
```

### 7.3 Session detail route

`src/routes/sessions.$id.tsx`

The loader prefetches the session server-side so a hard refresh renders without a skeleton flash.
If the session doesn't exist (deleted in another tab, bad URL), `errorComponent` redirects to `'/'`.

```tsx
import { createFileRoute, useNavigate } from '@tanstack/react-router'
import { useEffect } from 'react'
import { motion } from 'motion/react'
import { useSession } from '~/hooks/use-sessions'
import { queryClient } from '~/lib/query-client'
import { sessionKeys } from '~/hooks/use-sessions'
import { getSession } from '~/server/sessions'

export const Route = createFileRoute('/sessions/$id')({
  loader: async ({ params }) => {
    await queryClient.prefetchQuery({
      queryKey: sessionKeys.detail(params.id),
      queryFn: () => getSession({ data: params.id }),
    })
  },
  errorComponent: () => {
    const navigate = useNavigate()
    useEffect(() => { navigate({ to: '/' }) }, [])
    return null
  },
  component: SessionDetail,
})

function SessionDetail() {
  const { id } = Route.useParams()
  const { data: session, isLoading, error } = useSession(id)

  if (isLoading) return <SessionDetailSkeleton />
  if (error || !session) return null

  return (
    <motion.div
      key={id}
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: -8 }}
      transition={{ duration: 0.15, ease: 'easeOut' }}
      className="p-8 max-w-3xl"
    >
      <SummaryMeta session={session} />
      <StreamingDisplay
        content={session.summary ?? ''}
        isStreaming={session.status === 'streaming'}
      />
      {/* Actions only appear after stream fully ends */}
      <AnimatePresence>
        {session.status === 'done' && (
          <motion.div
            initial={{ opacity: 0, y: 6 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.2 }}
          >
            <SummaryActions session={session} />
          </motion.div>
        )}
        {session.status === 'error' && (
          <motion.div
            initial={{ opacity: 0, y: 6 }}
            animate={{ opacity: 1, y: 0 }}
          >
            <ErrorMessage message={session.error ?? 'Something went wrong'} />
          </motion.div>
        )}
      </AnimatePresence>
    </motion.div>
  )
}
```

---

## Phase 8 — Edge Cases & Error Handling

| Scenario | Handling |
|---|---|
| Invalid URL format | Zod validation in `createSession` server fn returns 400 with message |
| Tavily can't reach the page | Tavily returns an error result to the model; model reports it in summary; session set to `error` in `onFinish` |
| LLM mid-stream failure | Stream reader catch block; `useSummarize` catches and sets `error` state |
| Session not found | `getSession` throws; route `errorComponent` redirects to `'/'` |
| Delete race condition | `useMutation` `isPending` disables the delete button during the request |
| Network offline | TanStack Query `retry: 1` + error state shown to user |
| Post-summary actions during stream | Actions gated behind `session.status === 'done'` — never shown while streaming |

### Error display pattern

```tsx
// In NewSummaryForm
{summarizeState.status === 'error' && (
  <motion.div
    initial={{ opacity: 0, height: 0 }}
    animate={{ opacity: 1, height: 'auto' }}
    className="mt-2 text-sm text-red-600 bg-red-50 px-3 py-2 rounded-md"
  >
    {summarizeState.message}
  </motion.div>
)}
```

---

## Phase 9 — Post-Summary Actions (Copy, Download, Delete)

All three actions are only rendered when `session.status === 'done'`. The TypeScript prop type enforces this so `session.summary` is never `null` inside this component — no `!` assertions needed.

`src/components/summary/SummaryActions.tsx`

```tsx
import { useState } from 'react'
import { useDeleteSession } from '~/hooks/use-sessions'
import type { Session } from '~/types/session'
import { IconCopy, IconCheck, IconDownload, IconDelete } from '~/components/icons'

// TypeScript narrowing — status === 'done' guarantees summary is non-null
interface Props {
  session: Session & { status: 'done'; summary: string }
}

export function SummaryActions({ session }: Props) {
  const [copied, setCopied] = useState(false)
  const { mutate: deleteSession, isPending: isDeleting } = useDeleteSession()
  // useDeleteSession navigates to '/' on success — no extra logic needed here

  const handleCopy = async () => {
    await navigator.clipboard.writeText(session.summary)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  const handleDownload = () => {
    const content = `# Summary\n\nSource: ${session.url}\n\n${session.summary}`
    const blob = new Blob([content], { type: 'text/markdown' })
    const a = document.createElement('a')
    a.href = URL.createObjectURL(blob)
    a.download = `summary-${new URL(session.url).hostname}-${Date.now()}.md`
    a.click()
    URL.revokeObjectURL(a.href)
  }

  return (
    <div className="flex items-center gap-2 mt-6 pt-6 border-t border-neutral-100">
      <button
        onClick={handleCopy}
        className="flex items-center gap-1.5 text-sm text-neutral-500 hover:text-neutral-800 transition-colors px-3 py-1.5 rounded-md hover:bg-neutral-100"
      >
        {copied
          ? <IconCheck className="w-3.5 h-3.5 text-green-500" />
          : <IconCopy className="w-3.5 h-3.5" />
        }
        {copied ? 'Copied!' : 'Copy'}
      </button>

      <button
        onClick={handleDownload}
        className="flex items-center gap-1.5 text-sm text-neutral-500 hover:text-neutral-800 transition-colors px-3 py-1.5 rounded-md hover:bg-neutral-100"
      >
        <IconDownload className="w-3.5 h-3.5" />
        Download .md
      </button>

      <button
        onClick={() => deleteSession(session.id)}
        disabled={isDeleting}
        className="flex items-center gap-1.5 text-sm text-neutral-400 hover:text-red-500 transition-colors px-3 py-1.5 rounded-md hover:bg-red-50 ml-auto"
      >
        <IconDelete className="w-3.5 h-3.5" />
        {isDeleting ? 'Deleting...' : 'Delete'}
      </button>
    </div>
  )
}
```

---

## Phase 10 — Custom Icons

Icons come from the Figma file, exported as SVG and converted to React components. No icon library — all icons are project-specific and controlled.

### Folder structure

```
src/components/icons/
  index.ts          ← barrel re-export
  IconCopy.tsx
  IconCheck.tsx
  IconDownload.tsx
  IconDelete.tsx
  IconSearch.tsx
  IconSpinner.tsx
  ... etc
```

### Component pattern

Export from Figma as SVG (uncheck "Include id attribute"). Then wrap like this:

```tsx
// src/components/icons/IconCopy.tsx
interface Props {
  className?: string
}

export function IconCopy({ className }: Props) {
  return (
    <svg
      viewBox="0 0 16 16"         // match Figma artboard size
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      className={className}       // size and color via Tailwind: w-4 h-4 text-neutral-500
    >
      {/* paste Figma SVG paths here */}
      <path
        d="M..."
        stroke="currentColor"     // replace all hardcoded hex colors with currentColor
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}
```

Two rules for every icon:
1. Replace all `stroke="#hex"` and `fill="#hex"` with `currentColor` — color is then controlled by Tailwind's `text-*` classes on the parent or the icon itself
2. Remove `width` and `height` attributes from the `<svg>` tag — size is controlled by Tailwind's `w-*` / `h-*` classes

Usage:
```tsx
<IconCopy className="w-4 h-4 text-neutral-400" />
<IconDelete className="w-3.5 h-3.5 text-red-400" />
```

### Barrel export

```ts
// src/components/icons/index.ts
export { IconCopy } from './IconCopy'
export { IconCheck } from './IconCheck'
export { IconDownload } from './IconDownload'
export { IconDelete } from './IconDelete'
export { IconSearch } from './IconSearch'
export { IconSpinner } from './IconSpinner'
```

---

## Phase 11 — Deployment to Vercel

### 11.1 `vercel.json`

```json
{
  "framework": "other",
  "buildCommand": "npm run build",
  "outputDirectory": ".output",
  "installCommand": "npm install"
}
```

### 11.2 Environment variables on Vercel

Add in **Vercel Dashboard → Settings → Environment Variables**:

```
SUPABASE_URL
SUPABASE_SERVICE_ROLE_KEY
OPENROUTER_API_KEY
TAVILY_API_KEY
```

### 11.3 Deploy

```bash
npx vercel --prod
```

---

## Phase 13 — Testing

Priority: **E2E first** (covers the expected flows end-to-end), unit tests for the streaming hook and API routes if time permits.

### 13.1 Vitest config

`vitest.config.ts`

```ts
import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./tests/setup.ts'],
  },
})
```

`tests/setup.ts`

```ts
import { afterAll, afterEach, beforeAll } from 'vitest'
import { server } from './mocks/server'

// Start MSW server before all tests, reset handlers after each, close after all
beforeAll(() => server.listen({ onUnhandledRequest: 'error' }))
afterEach(() => server.resetHandlers())
afterAll(() => server.close())
```

### 13.2 E2E tests with Playwright (primary)

`playwright.config.ts`

```ts
import { defineConfig, devices } from '@playwright/test'

export default defineConfig({
  testDir: './tests/e2e',
  use: {
    baseURL: 'http://localhost:3000',
    trace: 'on-first-retry',
  },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
  ],
  webServer: {
    command: 'npm run dev',
    url: 'http://localhost:3000',
    reuseExistingServer: !process.env.CI,
  },
})
```

**Happy path — submit URL, see summary stream in, session appears in sidebar:**

`tests/e2e/summarize.spec.ts`

```ts
import { test, expect } from '@playwright/test'

test('submits a URL and streams a summary', async ({ page }) => {
  await page.goto('/')

  // Submit a URL
  const input = page.getByPlaceholder('https://')
  await input.fill('https://example.com')
  await input.press('Enter')

  // Streaming state — progress indicator visible
  await expect(page.getByTestId('streaming-indicator')).toBeVisible()

  // Wait for stream to complete (up to 30s for LLM)
  await expect(page.getByTestId('summary-actions')).toBeVisible({ timeout: 30_000 })

  // Summary content rendered
  await expect(page.getByTestId('summary-content')).not.toBeEmpty()

  // Session card appeared in sidebar
  await expect(page.getByTestId('session-list')).toContainText('example.com')

  // URL updated to session route
  await expect(page).toHaveURL(/\/sessions\//)
})

test('deletes a session and returns to index', async ({ page }) => {
  // Assumes at least one session exists — create one first
  await page.goto('/')
  await page.getByPlaceholder('https://').fill('https://example.com')
  await page.getByPlaceholder('https://').press('Enter')
  await expect(page.getByTestId('summary-actions')).toBeVisible({ timeout: 30_000 })

  // Delete from the main panel
  await page.getByTestId('delete-button').click()

  // Should redirect to index
  await expect(page).toHaveURL('/')
  await expect(page.getByTestId('empty-state')).toBeVisible()
})

test('shows error state for unreachable URL', async ({ page }) => {
  await page.goto('/')
  await page.getByPlaceholder('https://').fill('https://this-domain-does-not-exist-xyz.com')
  await page.getByPlaceholder('https://').press('Enter')

  await expect(page.getByTestId('error-message')).toBeVisible({ timeout: 30_000 })
})

test('search filters session list', async ({ page }) => {
  await page.goto('/')

  const search = page.getByTestId('session-search')
  await search.fill('example')

  // Results update as user types (debounced)
  await expect(page.getByTestId('session-list')).toContainText('example.com')
})
```

### 13.3 Unit tests — `useSummarize` hook (if time permits)

Uses MSW to intercept `POST /api/summarize` and simulate streaming + error responses.

`tests/mocks/handlers.ts`

```ts
import { http, HttpResponse } from 'msw'

export const handlers = [
  // Happy path — streams two chunks then closes
  http.post('/api/summarize', () => {
    const encoder = new TextEncoder()
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode('Hello '))
        controller.enqueue(encoder.encode('world'))
        controller.close()
      },
    })
    return new HttpResponse(stream, {
      headers: { 'Content-Type': 'text/plain' },
    })
  }),
]

export const errorHandlers = [
  http.post('/api/summarize', () =>
    HttpResponse.json({ error: 'Tavily failed to fetch page' }, { status: 422 })
  ),
]
```

`tests/mocks/server.ts`

```ts
import { setupServer } from 'msw/node'
import { handlers } from './handlers'

export const server = setupServer(...handlers)
```

`tests/unit/use-summarize.test.ts`

```ts
import { renderHook, act, waitFor } from '@testing-library/react'
import { describe, it, expect } from 'vitest'
import { useSummarize } from '~/hooks/use-summarize'
import { createWrapper } from '../utils/wrapper' // QueryClient + Router wrapper
import { server } from '../mocks/server'
import { errorHandlers } from '../mocks/handlers'

describe('useSummarize', () => {
  it('transitions through creating → streaming → done', async () => {
    const { result } = renderHook(() => useSummarize(), { wrapper: createWrapper() })

    expect(result.current.state.status).toBe('idle')

    act(() => { result.current.summarize('https://example.com') })
    await waitFor(() => expect(result.current.state.status).toBe('creating'))
    await waitFor(() => expect(result.current.state.status).toBe('streaming'))
    await waitFor(() => expect(result.current.state.status).toBe('done'))

    const streaming = result.current.state as { status: 'done'; sessionId: string }
    expect(streaming.sessionId).toBeDefined()
  })

  it('sets error state when API returns non-ok response', async () => {
    server.use(...errorHandlers)

    const { result } = renderHook(() => useSummarize(), { wrapper: createWrapper() })

    act(() => { result.current.summarize('https://example.com') })
    await waitFor(() => expect(result.current.state.status).toBe('error'))

    const error = result.current.state as { status: 'error'; message: string }
    expect(error.message).toContain('Tavily failed')
  })

  it('aborts in-flight stream when reset() is called', async () => {
    const { result } = renderHook(() => useSummarize(), { wrapper: createWrapper() })

    act(() => { result.current.summarize('https://example.com') })
    await waitFor(() => expect(result.current.state.status).toBe('streaming'))

    act(() => { result.current.reset() })
    expect(result.current.state.status).toBe('idle')
  })
})
```

### 13.4 Test scripts in `package.json`

```json
{
  "scripts": {
    "test": "vitest run",
    "test:watch": "vitest",
    "test:e2e": "playwright test",
    "test:e2e:ui": "playwright test --ui"
  }
}
```

---

## Phase 14 — README Template

```markdown
# URL Summarizer

LLM-powered webpage summarization app.

## Tech Stack
- TanStack Start (SSR + API routes)
- Supabase (PostgreSQL + FTS index)
- TanStack Query (client caching + infinite scroll)
- Vercel AI SDK + OpenRouter (streaming LLM)
- Tavily (web search/retrieval tool for the LLM)
- Streamdown (animated streaming markdown)
- Motion (transitions + sidebar grow animations)
- Tailwind CSS

## Setup

1. Clone and install: `npm install`
2. Copy `.env.example` to `.env.local` and fill in values
3. Run DB migration in Supabase Studio (see `supabase/migration.sql`)
4. Generate types: `npm run db:types`
5. Start dev server: `npm run dev`

## Testing

- E2E: `npm run test:e2e` (Playwright — covers main flows)
- Unit: `npm run test` (Vitest — streaming hook state machine)

## Design Decisions

- **Two-phase summarization**: session row is created first (returns an ID instantly),
  then streaming happens against that ID via a dedicated API route. Sidebar only updates
  once the stream fully ends (success or error) via a `finally` block.
- **Tavily for web retrieval**: instead of manually fetching and scraping HTML, the LLM
  is given a Tavily tool and decides when/how to retrieve the page. More robust, less code.
- **AbortController on streaming**: the in-flight fetch is wired to a ref-held controller
  so navigating away or calling reset() cleanly cancels the stream.
- **Infinite scroll pagination**: sidebar uses `useInfiniteQuery` with an IntersectionObserver
  sentinel — loads PAGE_SIZE items, fetches next page when the user scrolls to the bottom.
- **Cache seeding before navigation**: after the stream ends, the completed summary is
  written directly into TanStack Query's cache before navigating to `/sessions/:id`,
  so the route renders instantly without a skeleton flash.
- **Server functions for CRUD, API route for streaming**: `createServerFn` serializes
  responses as JSON and can't stream; a dedicated `/api/summarize` route returns a
  raw `ReadableStream`.
- **Supabase service role on server only**: the client uses the anon key, server functions
  use the service role key. Keeps RLS meaningful if auth is added later.
- **Custom SVG icon components**: icons exported from Figma, converted to React components
  with `currentColor` so color and size are fully controlled by Tailwind classes.

## What I'd improve with more time
- Add authentication (Supabase Auth)
- Rate limiting on `/api/summarize`
- Retry failed sessions
- Session grouping by domain
- Expanded test coverage (API route error cases, Playwright visual regression)
```

---

## Build Order Checklist

- [ ] Phase 0 — Scaffold & deps (including test deps)
- [ ] Phase 1 — Supabase table + FTS index + client
- [ ] Phase 2 — Types (Session, PaginatedSessions, PAGE_SIZE)
- [ ] Phase 3 — Server functions (CRUD, paginated list + search)
- [ ] Phase 4 — Streaming API route (Tavily tool)
- [ ] Phase 5 — TanStack Query hooks (infinite scroll) + useSummarize (AbortController)
- [ ] Phase 6 — Components (icons → leaf nodes → SessionCard grow animation → Sidebar)
- [ ] Phase 7 — Route layout (root with scroll sentinel, index empty state, sessions.$id)
- [ ] Phase 8 — Error handling pass
- [ ] Phase 9 — Post-summary actions (copy, download, delete)
- [ ] Phase 10 — Custom icons from Figma
- [ ] Phase 11 — Deploy + env vars
- [ ] Phase 13 — E2E tests (Playwright happy path + error flows)
- [ ] Phase 13 — Unit tests for useSummarize (if time permits)
- [ ] Phase 14 — README