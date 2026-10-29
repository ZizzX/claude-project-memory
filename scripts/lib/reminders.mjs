// Reminder wording: a title that names an event to wait for (a release, a merge, a flag to flip, someone's
// answer) rather than work to do. Used by the `pm task new` hint; a heuristic, so it only ever suggests.
// ponytail: a word list, Russian and English; widen it from real titles that slipped through, not by guessing.

const START = '(?<![\\p{L}\\p{N}_])'; // a word start that also works for Cyrillic
const words = (...patterns) => patterns.map((p) => new RegExp(`${START}(?:${p})`, 'iu'));

const FLAG_VERBS = 'снять|снятие|убрать|удалить|выпилить|включить|выключить|отключить|remove|delete|drop|clean\\s*up|enable|disable|turn\\s+(?:on|off)|flip';
// Who a reminder is addressed to, in the dative ("написать бэку") or after "у" ("уточнить у бэка").
const TO_RU = 'бэку|беку|бэкенду|бекенду|бэкендерам|фронту|фронтенду|qa|тестировщикам|дизайнеру|аналитику|продукту|лиду|команде|@';
const AT_RU = 'бэк|бек|фронт|qa|тестиров|дизайнер|аналитик|продукт|лид|команд';
const TEAM_EN = 'backend|frontend|qa|design|designers?|product|pm|po|lead|team|devops|@\\S+';

const PATTERNS = words(
  // a flag to flip: "снять флаг X", "remove the X flag", "enable feature flag X" — not a "flags column"
  `(?:${FLAG_VERBS})\\s+(?:\\S+\\s+){0,2}?(?:фич[аеиу]?[- ]?)?флаг`,
  `(?:${FLAG_VERBS})\\s+(?:the\\s+|a\\s+)?(?:\\S+\\s+)?(?:feature\\s+)?flags?(?![\\p{L}])(?!\\s+(?:column|field|icon|table|emoji|image|picker))`,
  'flags?\\s+(?:removal|cleanup|clean-up)',
  // after an event, the event word whole: "после прода" is a reminder, "после продажи" is not
  'после\\s+(?:прод(?:а|е|у)?(?![\\p{L}])|прод-|релиз|тег|выкат|деплоя|деплой|мёрж|мерж|мердж|влития|ответа|снятия\\s+код|код-фриз|раскат)',
  'after\\s+(?:the\\s+)?(?:release|prod(?:uction)?|tag|rollout|merge(?!\\s+conflict)|deploy(?:ment)?|backend|code\\s+freeze|answer|reply)(?![\\p{L}])',
  'когда\\s+.{0,40}?(?:release\\s+notes|в\\s+проде|на\\s+проде|в\\s+релизе|выкат|смерж|влит)',
  'once\\s+.{0,40}?(?:merged|released|deployed|shipped)',
  // waiting for someone, telling or asking someone
  'ждём|ждем|дождаться|подождать|ожидаем',
  `(?:написать|сказать|передать|пингануть|напомнить)\\s+(?:${TO_RU})`,
  'напомнить\\s+(?:про|о|об)(?![\\p{L}])',
  `(?:спросить|уточнить|узнать)\\s+у\\s+(?:${AT_RU})`,
  `согласовать\\s+с\\s+(?:${AT_RU})`,
  `(?:ask|tell|ping|check\\s+with)\\s+(?:the\\s+)?(?:${TEAM_EN})(?:\\s+team)?\\s+(?:about|to|whether|if|for|on)(?![\\p{L}])`,
  `remind\\s+(?:me|us|them|qa|@\\S+|(?:the\\s+)?\\S+\\s+(?:to|about))(?![\\p{L}])`,
);

// "Wait for …" is a reminder at the start of a title, not inside one ("implement wait for element helper").
const WAIT_START = /^\W*(?:[A-Z][A-Z0-9]*-\d+\W*)?wait(?:ing)?\s+(?:for|on|until)(?![\p{L}])/iu;

// "Включить PKB_REPORT_ENABLED по умолчанию": a flag verb followed by a flag-like constant (case matters there).
const CONSTANT = new RegExp(`${START}(?:${FLAG_VERBS})\\s+(\\S+)`, 'giu');
const FLAG_NAME = /^(?:FF_|FEATURE_)?[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)*_(?:ENABLED|DISABLED|FLAG|FF)$|^(?:FF|FEATURE)_[A-Z0-9_]+$/;

export function isReminderTitle(title) {
  const text = String(title ?? '');
  if (WAIT_START.test(text) || PATTERNS.some((re) => re.test(text))) return true;
  return [...text.matchAll(CONSTANT)].some((m) => FLAG_NAME.test(m[1].replace(/[^\w]+$/, '')));
}
