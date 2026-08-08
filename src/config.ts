import 'dotenv/config'
import { z } from 'zod'

/**
 * Единая точка чтения конфигурации: процесс падает здесь, на старте, с
 * понятным сообщением, а не молча посреди работы.
 */

const required = (hint: string) =>
  z
    .string()
    .optional()
    .transform(v => v ?? '')
    .pipe(z.string().min(1, hint))

const int = (fallback: number) =>
  z
    .string()
    .optional()
    .transform(v => (v === undefined || v === '' ? fallback : Number(v)))
    .pipe(z.number().int().positive())

const schema = z.object({
  TG_API_ID: required('не заполнен — возьми на my.telegram.org → API development tools')
    .transform(Number)
    .pipe(z.number().int().positive('должен быть числом')),
  TG_API_HASH: required('не заполнен — возьми на my.telegram.org → API development tools'),
  TG_SESSION_PATH: z.string().default('./data/session.sqlite'),

  SPOTIFY_CLIENT_ID: required('не заполнен — создай приложение на developer.spotify.com'),
  SPOTIFY_CLIENT_SECRET: required('не заполнен — там же, где client id'),
  SPOTIFY_REFRESH_TOKEN: required('пуст — получи через `npm run spotify:login`'),

  /** Пустая строка — путь через инлайн-ботов выключен. */
  MUSIC_INLINE_BOTS: z
    .string()
    .optional()
    .transform(v =>
      (v ?? 'Shazambot')
        .split(',')
        .map(s => s.trim())
        .filter(Boolean),
    ),

  /**
   * Куда складывать треки, полученные от инлайн-бота.
   *
   * Промежуточный чат нужен по устройству: результат инлайн-бота нельзя взять
   * «в руки», его можно только отправить куда-то, а вот уже отправленный файл
   * доступен как ссылка. Пусто — «Избранное».
   */
  MUSIC_CACHE_CHAT: z
    .string()
    .optional()
    .transform(v => (v === undefined || v.trim() === '' ? 'me' : v.trim())),

  POLL_MS: int(3000),
})

const parsed = schema.safeParse(process.env)

if (!parsed.success) {
  const lines = parsed.error.issues.map(i => `  • ${i.path.join('.') || '(root)'}: ${i.message}`)
  console.error(`Не заполнен .env:\n${lines.join('\n')}`)
  process.exit(1)
}

export const config = parsed.data
