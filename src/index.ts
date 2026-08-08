import type { tl } from '@mtcute/core'
import { startClient, tg } from './client.js'
import { config } from './config.js'
import { findTrack } from './finder.js'
import { logger } from './logger.js'
import { nowPlaying, type NowPlaying } from './spotify.js'

/**
 * Синхронизация: что играет в Spotify — то стоит в музыке профиля Telegram.
 *
 * Музыка профиля — это не сообщения и не закреп, а отдельный список
 * документов: `account.saveMusic` добавляет трек, он же с флагом `unsave`
 * убирает. Поэтому программа никому ничего не пишет и ничего не удаляет —
 * только правит этот список.
 *
 * Трогаем при этом исключительно то, что поставили сами: помним документ
 * текущего трека и снимаем только его. Добавленное тобой руками остаётся.
 */

/** За сколько до конца трека просыпаемся, чтобы сменить его вовремя. */
const LEAD_MS = 2000

/** Чаще этого не спрашиваем даже у самого конца трека. */
const MIN_POLL_MS = 2000

interface Current {
  /** Ключ трека — по нему видно, что играет уже другое. */
  key: string
  /** Документ — им же трек и снимать. */
  doc: tl.TypeInputDocument
}

let current: Current | null = null
let stopping = false

async function main(): Promise<void> {
  await startClient()
  logger.info({ pollMs: config.POLL_MS }, 'синхронизация запущена')

  while (!stopping) {
    const waitMs = await tick()
    await sleep(waitMs)
  }
}

/** Один цикл. Возвращает, сколько спать до следующего. */
async function tick(): Promise<number> {
  const track = await nowPlaying()

  if (track === null || !track.isPlaying || track.kind !== 'track') {
    // Ничего не играет — в профиле пусто.
    await clear()
    return config.POLL_MS
  }

  if (current?.key !== keyOf(track)) await show(track)

  /*
   * Спим до конца трека, но не дольше обычного шага опроса: шаг — это и есть
   * время реакции на перемотку и ручное переключение, а расчёт конца умеет
   * только сокращать сон, не удлинять.
   */
  const left = track.durationMs - track.progressMs - LEAD_MS
  return Math.min(Math.max(left, MIN_POLL_MS), config.POLL_MS)
}

/** Ставит трек в профиль. */
async function show(track: NowPlaying): Promise<void> {
  const durationSec = Math.round(track.durationMs / 1000)
  const doc = await findTrack(track.artists, track.title, durationSec)

  if (doc === null) {
    logger.debug({ title: track.title }, 'файл трека не нашёлся — профиль без изменений')
    return
  }

  const previous = current

  await tg.call({ _: 'account.saveMusic', id: doc })
  current = { key: keyOf(track), doc }
  logger.info({ artists: track.artists.join(', '), title: track.title }, 'трек в профиле')

  // Прошлый снимаем после того, как новый уже в списке: иначе профиль на
  // мгновение оставался бы пустым.
  if (previous !== null) await unsave(previous)
}

async function clear(): Promise<void> {
  if (current === null) return
  const previous = current
  current = null
  await unsave(previous)
}

async function unsave(entry: Current): Promise<void> {
  await tg
    .call({ _: 'account.saveMusic', id: entry.doc, unsave: true })
    .catch(err => logger.warn({ err }, 'не удалось убрать трек из профиля'))
}

/**
 * Чем отличаем один трек от другого. Ссылка уникальна; у локальных файлов её
 * может не быть, тогда сгодится исполнитель с названием.
 */
function keyOf(track: NowPlaying): string {
  return track.url ?? `${track.artists.join(',')} — ${track.title}`
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

async function shutdown(signal: string): Promise<void> {
  logger.info({ signal }, 'останавливаюсь')
  stopping = true
  // Уходим — в профиле не должна остаться песня, которая уже не играет.
  await clear()
  await tg.destroy().catch(() => {})
  process.exit(0)
}

process.on('SIGINT', () => void shutdown('SIGINT'))
process.on('SIGTERM', () => void shutdown('SIGTERM'))

main().catch(err => {
  logger.fatal({ err }, 'не удалось запуститься')
  process.exit(1)
})
