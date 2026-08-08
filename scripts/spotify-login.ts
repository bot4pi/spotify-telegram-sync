import { createServer } from 'node:http'
import 'dotenv/config'

/**
 * Разовое получение refresh-токена Spotify.
 *
 * Поднимает локальный сервер на 127.0.0.1:8888, открывает ссылку авторизации и
 * ловит код с редиректа. Токен печатается в терминал — его нужно положить в
 * `.env` как `SPOTIFY_REFRESH_TOKEN`.
 *
 * Именно петлевой IP, а не `localhost`: Spotify с некоторых пор принимает в
 * Redirect URI только его. В настройках приложения должно стоять ровно
 * `http://127.0.0.1:8888/callback`.
 */

const PORT = 8888
const REDIRECT_URI = `http://127.0.0.1:${PORT}/callback`

const clientId = process.env['SPOTIFY_CLIENT_ID'] ?? ''
const clientSecret = process.env['SPOTIFY_CLIENT_SECRET'] ?? ''

if (clientId === '' || clientSecret === '') {
  console.error('Заполни SPOTIFY_CLIENT_ID и SPOTIFY_CLIENT_SECRET в .env')
  process.exit(1)
}

const authUrl = new URL('https://accounts.spotify.com/authorize')
authUrl.searchParams.set('client_id', clientId)
authUrl.searchParams.set('response_type', 'code')
authUrl.searchParams.set('redirect_uri', REDIRECT_URI)
// Единственное нужное право: читать, что играет сейчас.
authUrl.searchParams.set('scope', 'user-read-currently-playing')

console.log('\nОткрой в браузере и разреши доступ:\n')
console.log(authUrl.toString())
console.log('\nЖду ответа...\n')

const server = createServer((req, res) => {
  const url = new URL(req.url ?? '/', `http://127.0.0.1:${PORT}`)
  if (url.pathname !== '/callback') {
    res.writeHead(404).end()
    return
  }

  const code = url.searchParams.get('code')
  if (code === null) {
    res.writeHead(400).end('Нет кода в ответе')
    return
  }

  res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' })
  res.end('Готово. Вернись в терминал.')

  void exchange(code).finally(() => server.close())
})

server.listen(PORT, '127.0.0.1')

async function exchange(code: string): Promise<void> {
  const basic = Buffer.from(`${clientId}:${clientSecret}`).toString('base64')

  const res = await fetch('https://accounts.spotify.com/api/token', {
    method: 'POST',
    headers: {
      Authorization: `Basic ${basic}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: REDIRECT_URI,
    }),
  })

  if (!res.ok) {
    console.error(`Spotify отказал: HTTP ${res.status}`)
    console.error(await res.text())
    process.exit(1)
  }

  const body = (await res.json()) as { refresh_token?: string }
  if (body.refresh_token === undefined) {
    console.error('В ответе нет refresh_token')
    process.exit(1)
  }

  console.log('Положи это в .env:\n')
  console.log(`SPOTIFY_REFRESH_TOKEN=${body.refresh_token}\n`)
  process.exit(0)
}
