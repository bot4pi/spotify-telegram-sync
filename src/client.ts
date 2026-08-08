import { mkdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { TelegramClient } from '@mtcute/node'
import { config } from './config.js'
import { logger } from './logger.js'

const SESSION_PATH = resolve(config.TG_SESSION_PATH)
mkdirSync(dirname(SESSION_PATH), { recursive: true })

export const tg = new TelegramClient({
  apiId: config.TG_API_ID,
  apiHash: config.TG_API_HASH,
  // Строка = путь к файлу SQLite-сессии: хранилище встроено в @mtcute/node,
  // отдельный пакет для него не нужен.
  storage: SESSION_PATH,
  logLevel: 2,
})

export type Tg = typeof tg

/**
 * Вход в аккаунт. Первый запуск спрашивает телефон, код и пароль 2FA в
 * терминале; последующие берут сессию из файла и молчат.
 */
export async function startClient(): Promise<void> {
  const self = await tg.start({
    phone: () => tg.input('Телефон: '),
    code: () => tg.input('Код из Telegram: '),
    password: () => tg.input('Пароль 2FA: '),
  })

  logger.info({ id: self.id, username: self.username }, 'вошли в аккаунт')
}
