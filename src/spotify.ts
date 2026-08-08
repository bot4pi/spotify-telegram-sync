import { config } from './config.js'
import { logger } from './logger.js'

/**
 * Клиент Spotify: только то, что играет сейчас.
 *
 * Полного аудио Web API не отдаёт вовсе, а 30-секундный `preview_url` с конца
 * 2024 года закрыт для новых приложений — поэтому здесь только метаданные, а
 * сам файл ищется в Telegram (см. `finder.ts`).
 */

const TOKEN_URL = 'https://accounts.spotify.com/api/token'
const NOW_PLAYING_URL =
  'https://api.spotify.com/v1/me/player/currently-playing?additional_types=track,episode'

export interface NowPlaying {
  title: string
  artists: string[]
  durationMs: number
  progressMs: number
  isPlaying: boolean
  /** Ссылка на трек — уникальный ключ, по нему видно смену. */
  url: string | null
  /** `episode` — подкаст: искать аудио по нему бессмысленно. */
  kind: 'track' | 'episode'
}

/**
 * Токен доступа живёт час, поэтому держим его в памяти и обновляем заранее.
 * Refresh-токен постоянный и лежит в `.env`.
 */
let token: { value: string; expiresAt: number } | null = null

async function accessToken(): Promise<string> {
  // Минута запаса: запрос, начатый на последней секунде жизни токена, успел бы
  // отправиться с уже протухшим.
  if (token !== null && Date.now() < token.expiresAt - 60_000) return token.value

  const basic = Buffer.from(
    `${config.SPOTIFY_CLIENT_ID}:${config.SPOTIFY_CLIENT_SECRET}`,
  ).toString('base64')

  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${basic}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: config.SPOTIFY_REFRESH_TOKEN,
    }),
    signal: AbortSignal.timeout(15_000),
  })

  if (!res.ok) {
    throw new Error(`не удалось обновить токен Spotify: HTTP ${res.status}`)
  }

  const body = (await res.json()) as { access_token: string; expires_in: number }
  token = { value: body.access_token, expiresAt: Date.now() + body.expires_in * 1000 }
  return token.value
}

/** `null` — плеер молчит либо Spotify не ответил. */
export async function nowPlaying(): Promise<NowPlaying | null> {
  try {
    const res = await fetch(NOW_PLAYING_URL, {
      headers: { Authorization: `Bearer ${await accessToken()}` },
      signal: AbortSignal.timeout(10_000),
    })

    // 204 — «сейчас ничего не играет», это штатный ответ, а не сбой.
    if (res.status === 204) return null
    if (!res.ok) {
      logger.warn({ status: res.status }, 'Spotify ответил ошибкой')
      return null
    }

    const body = (await res.json()) as {
      is_playing?: boolean
      progress_ms?: number
      currently_playing_type?: string
      item?: {
        name?: string
        duration_ms?: number
        external_urls?: { spotify?: string }
        artists?: Array<{ name?: string }>
      } | null
    }

    const item = body.item
    if (item?.name === undefined) return null

    return {
      title: item.name,
      artists: (item.artists ?? []).map(a => a.name ?? '').filter(Boolean),
      durationMs: item.duration_ms ?? 0,
      progressMs: body.progress_ms ?? 0,
      isPlaying: body.is_playing === true,
      url: item.external_urls?.spotify ?? null,
      kind: body.currently_playing_type === 'episode' ? 'episode' : 'track',
    }
  } catch (err) {
    logger.warn({ err }, 'опрос Spotify не удался')
    return null
  }
}
