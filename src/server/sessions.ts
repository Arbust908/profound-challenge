import { createServerFn } from '@tanstack/react-start'
import { z } from 'zod'
import { supabaseServer } from '~/lib/supabase-server'
import type { Session, PaginatedSessions } from '~/types/session'
import { DEFAULT_PAGE_SIZE } from '~/types/session'

const PageInput = z.object({ page: z.number().int().min(1).default(1) })

export const listSessions = createServerFn({ method: 'GET' })
  .inputValidator((input: unknown) => PageInput.parse(input))
  .handler(async ({ data }): Promise<PaginatedSessions> => {
    const { page } = data
    const from = (page - 1) * DEFAULT_PAGE_SIZE
    const to = from + DEFAULT_PAGE_SIZE - 1

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
      pageSize: DEFAULT_PAGE_SIZE,
      hasNextPage: (count ?? 0) > page * DEFAULT_PAGE_SIZE,
    }
  })

export const getSession = createServerFn({ method: 'GET' })
  .inputValidator((id: string) => id)
  .handler(async ({ data: id }): Promise<Session> => {
    const { data, error } = await supabaseServer
      .from('sessions')
      .select('*')
      .eq('id', id)
      .single()

    if (error) throw new Error(error.message)
    return data
  })

export const deleteSession = createServerFn({ method: 'POST' })
  .inputValidator((id: string) => id)
  .handler(async ({ data: id }) => {
    const { error } = await supabaseServer
      .from('sessions')
      .delete()
      .eq('id', id)

    if (error) throw new Error(error.message)
    return { success: true }
  })

const SearchInput = z.object({
  query: z.string(),
  page: z.number().int().min(1).default(1),
})

export const searchSessions = createServerFn({ method: 'GET' })
  .inputValidator((input: unknown) => SearchInput.parse(input))
  .handler(async ({ data }): Promise<PaginatedSessions> => {
    const { query, page } = data
    const from = (page - 1) * DEFAULT_PAGE_SIZE
    const to = from + DEFAULT_PAGE_SIZE - 1

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
      pageSize: DEFAULT_PAGE_SIZE,
      hasNextPage: (count ?? 0) > page * DEFAULT_PAGE_SIZE,
    }
  })

  const CreateInput = z.object({ url: z.string().url() })

export const createSession = createServerFn({ method: 'POST' })
  .inputValidator((input: unknown) => CreateInput.parse(input))
  .handler(async ({ data }): Promise<Session> => {
    const { data: session, error } = await supabaseServer
      .from('sessions')
      .insert({ url: data.url, status: 'pending' })
      .select()
      .single()

    if (error) throw new Error(error.message)
    return session
  })