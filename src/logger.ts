import pino from 'pino'

/**
 * Логи. В разработке — человекочитаемые, в проде — JSON построчно, каким его
 * ждут journald и любой сборщик.
 *
 * `redact` не для красоты: без него токен Spotify и хэш приложения Telegram
 * рано или поздно окажутся в логе целиком — обычно вместе со стектрейсом
 * неудачного запроса.
 */
export const logger = pino({
  level: process.env['LOG_LEVEL'] ?? 'info',
  redact: {
    paths: [
      'apiHash',
      'TG_API_HASH',
      'SPOTIFY_CLIENT_SECRET',
      'SPOTIFY_REFRESH_TOKEN',
      'accessToken',
      'refresh_token',
      'access_token',
      '*.authorization',
    ],
    censor: '[скрыто]',
  },
  ...(process.env['NODE_ENV'] === 'production'
    ? {}
    : { transport: { target: 'pino-pretty', options: { translateTime: 'HH:MM:ss' } } }),
})
