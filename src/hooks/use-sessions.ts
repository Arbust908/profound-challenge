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
