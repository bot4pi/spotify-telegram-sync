import type { Audio, tl } from '@mtcute/core'
import { randomLong } from '@mtcute/core/utils.js'
import { SearchFilters } from '@mtcute/core'
import { tg } from './client.js'
import { config } from './config.js'
import { logger } from './logger.js'

/**
 * Поиск файла трека внутри Telegram.
 *
 * Два источника, по порядку. Сначала собственные чаты: если трек уже где-то
 * лежит — в музыкальном канале, в переписке, в кэш-чате, — брать его можно
 * ссылкой, ничего не скачивая. Затем инлайн-боты.
 *
 * Скачивания нет нигде и намеренно: программа работает фоном и часто, а
 * тянуть файл с YouTube по десять секунд ради строчки в профиле не стоит.
 * Не нашлось быстро — трек пропускается.
 */

/** Сколько результатов смотрим: дальше первых совпадения уже случайные. */
const SEARCH_LIMIT = 20

/** Расхождение в длине, после которого это уже другая версия трека. */
const MAX_DRIFT_SEC = 30

/** Ниже этого битрейта — обрезок, а не трек. */
const MIN_KBPS = 48

/** Приметы неоригинальной записи и отрывков. */
const NOT_STUDIO =
  /(live|концерт|acoustic|акустик|cover|кавер|remix|ремикс|slowed|sped|reverb|karaoke|караоке|instrumental|минус|mashup|нарезк|snippet|preview|отрыв|фрагмент)/i

/** Для сравнения: без регистра, знаков и лишних пробелов. */
function normalize(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
}

/**
 * Документ трека или `null`, если быстро найти не вышло.
 *
 * Возвращаем именно `InputDocument`: музыке профиля нужен он, а не сообщение.
 */
export async function findTrack(
  artists: string[],
  title: string,
  durationSec: number,
): Promise<tl.TypeInputDocument | null> {
  const fromChats = await searchChats(artists, title, durationSec)
  if (fromChats !== null) return fromChats

  return await askInlineBots(artists, title, durationSec)
}

/** Поиск по всем своим диалогам через полнотекстовый поиск Telegram. */
async function searchChats(
  artists: string[],
  title: string,
  durationSec: number,
): Promise<tl.TypeInputDocument | null> {
  const wantTitle = normalize(title)
  if (wantTitle === '') return null

  const query = `${artists.join(' ')} ${title}`.trim()

  try {
    const found = await tg.searchGlobal({
      query,
      filter: SearchFilters.Audio,
      limit: SEARCH_LIMIT,
    })

    for (const msg of found) {
      const media = msg.media
      if (media === null || !('type' in media) || media.type !== 'audio') continue
      if (!matches(media, artists, wantTitle)) continue

      /*
       * Длительность сверяем обязательно: в чатах полно концертных записей и
       * «замедленных» версий, подписанных ровно как оригинал. По названию они
       * неотличимы, по длине — сразу.
       */
      if (media.duration > 0 && Math.abs(media.duration - durationSec) > MAX_DRIFT_SEC) continue
      if (NOT_STUDIO.test(`${media.title ?? ''} ${media.fileName ?? ''}`)) continue

      return media.inputDocument
    }
  } catch (err) {
    logger.debug({ query, err }, 'поиск по чатам не удался')
  }

  return null
}

/**
 * Совпадение считаем по названию и исполнителю сразу.
 *
 * Одного названия мало: «Creep» есть у десятка исполнителей, и поставить в
 * профиль чужой кавер вместо того, что играет, хуже, чем не поставить ничего.
 */
function matches(audio: Audio, artists: string[], wantTitle: string): boolean {
  const haystack = normalize(
    [audio.title, audio.performer, audio.fileName].filter(Boolean).join(' '),
  )
  if (haystack === '' || !haystack.includes(wantTitle)) return false

  // Исполнителя достаточно любого из списка: в подписях обычно указан только
  // основной, без приглашённых.
  return artists.some(a => {
    const norm = normalize(a)
    return norm !== '' && haystack.includes(norm)
  })
}

/**
 * Спрашивает трек у инлайн-ботов из конфига, по порядку.
 *
 * Результат бота нельзя взять «в руки» — его можно только отправить, — поэтому
 * он уходит в промежуточный чат, а оттуда мы забираем уже готовый документ.
 * Побочный эффект полезен: этот чат попадает в область поиска первого шага, и
 * второй раз тот же трек находится там сразу, без обращения к ботам.
 */
async function askInlineBots(
  artists: string[],
  title: string,
  durationSec: number,
): Promise<tl.TypeInputDocument | null> {
  const bots = config.MUSIC_INLINE_BOTS
  if (bots.length === 0) return null

  const query = `${artists.join(' ')} ${title}`.trim()
  if (query === '') return null

  const peer = await tg.resolvePeer(config.MUSIC_CACHE_CHAT).catch(() => null)
  if (peer === null) {
    logger.warn({ chat: config.MUSIC_CACHE_CHAT }, 'промежуточный чат недоступен')
    return null
  }

  for (const bot of bots) {
    try {
      const results = await tg.call({
        _: 'messages.getInlineBotResults',
        bot: await tg.resolveUser(bot),
        peer,
        query,
        offset: '',
      })

      const picked = pick(results, durationSec)
      if (picked === null) continue

      const sent = await tg.call({
        _: 'messages.sendInlineBotResult',
        peer,
        randomId: randomLong(),
        queryId: results.queryId,
        id: picked,
        // Приписка «via @бот» — деталь реализации, в переписке ей делать нечего.
        hideVia: true,
        silent: true,
      })

      const doc = extractDocument(sent)
      if (doc !== null) return doc
    } catch (err) {
      /*
       * На warn, а не debug: сюда попадает и «бот не поддерживает инлайн», и
       * «такого юзернейма нет» — обе причины означают, что строка в конфиге
       * бесполезна, и знать об этом надо сразу.
       */
      logger.warn({ bot, err }, 'инлайн-бот не ответил')
    }
  }

  return null
}

/** Идентификатор подходящего результата из выдачи бота. */
function pick(results: tl.messages.TypeBotResults, durationSec: number): string | null {
  for (const result of results.results) {
    // Боты, отдающие ссылки вместо файлов, нам не подходят: отправлять оттуда
    // нечего.
    if (result._ !== 'botInlineMediaResult') continue

    const doc = result.document
    if (doc === undefined || doc._ !== 'document') continue

    const audio = doc.attributes.find(a => a._ === 'documentAttributeAudio')
    // Голосовые приходят с тем же атрибутом — это не трек.
    if (audio === undefined || audio.voice === true) continue

    /*
     * Длительность обязана быть известна и совпасть. Раньше проверка стояла
     * под условием «если известна», и файл без неё проходил насквозь — так
     * прилетают тридцатисекундные превью вместо треков.
     */
    if (audio.duration <= 0) continue
    if (Math.abs(audio.duration - durationSec) > MAX_DRIFT_SEC) continue

    // Обрезок, выдающий себя за полный трек, ловим по битрейту: длину он
    // объявляет настоящую, а весит столько, сколько на неё не хватило бы.
    if (doc.size > 0 && (doc.size * 8) / audio.duration / 1000 < MIN_KBPS) continue

    const fileName = doc.attributes.find(a => a._ === 'documentAttributeFilename')?.fileName
    if (NOT_STUDIO.test(`${audio.title ?? ''} ${audio.performer ?? ''} ${fileName ?? ''}`)) continue

    return result.id
  }

  return null
}

/**
 * Достаёт документ из ответа на отправку.
 *
 * Telegram отвечает не сообщением, а пачкой обновлений; нужное — первое новое
 * сообщение с документом.
 */
function extractDocument(updates: tl.TypeUpdates): tl.TypeInputDocument | null {
  if (updates._ !== 'updates' && updates._ !== 'updatesCombined') return null

  for (const update of updates.updates) {
    if (update._ !== 'updateNewMessage' && update._ !== 'updateNewChannelMessage') continue

    const message = update.message
    if (message._ !== 'message') continue

    const media = message.media
    if (media === undefined || media._ !== 'messageMediaDocument') continue

    const doc = media.document
    if (doc !== undefined && doc._ === 'document') {
      return {
        _: 'inputDocument',
        id: doc.id,
        accessHash: doc.accessHash,
        fileReference: doc.fileReference,
      }
    }
  }

  return null
}
