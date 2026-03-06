/**
 * Represents the valid states for a summarization session.
 * Aligned with the CHECK constraint in the database.
 */
export type SessionStatus = 'pending' | 'streaming' | 'done' | 'error';

/**
 * The full shape of a row in the 'sessions' table.
 * Timestamps are typically returned as ISO strings from the API,
 * but can be Date objects when working with the database directly.
 */
export interface Session {
  id: string;               // uuid
  url: string;              // text
  title: string | null;     // text (nullable)
  summary: string | null;   // text (nullable)
  status: SessionStatus;    // text with check constraint
  error: string | null;     // text (nullable)
  created_at: string | Date; // timestamptz - API returns string, DB might return Date
  updated_at: string | Date; // timestamptz
}

/**
 * Type for inserting a new session.
 * Fields with defaults or that are nullable are marked as optional.
 */
export interface InsertSession {
  id?: string;
  url: string;
  title?: string | null;
  summary?: string | null;
  status?: SessionStatus;
  error?: string | null;
  created_at?: string | Date;
  updated_at?: string | Date;
}

/**
 * Simplified input for creating a new session via API.
 * Only requires the URL, other fields get sensible defaults.
 */
export interface CreateSessionInput {
  url: string;
}

/**
 * Type for updating an existing session.
 * Excludes immutable fields like id and created_at.
 */
export type UpdateSession = Partial<Omit<Session, 'id' | 'created_at'>>;

/**
 * Input for searching sessions.
 */
export interface SearchSessionsInput {
  query: string;
  page?: number;
  pageSize?: number;
}

/**
 * Paginated response for sessions list.
 */
export interface PaginatedSessions {
  data: Session[];
  total: number;
  page: number;
  pageSize: number;
  hasNextPage: boolean;
}

/**
 * Default page size for pagination.
 */
export const DEFAULT_PAGE_SIZE = 20;