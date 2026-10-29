// Reminder wording: a title that names an event to wait for (a release, a merge, a flag to flip, someone's
// answer) rather than work to do. Used by the `pm task new` hint; a heuristic, so it only ever suggests.
// ponytail: a word list, Russian and English; widen it from real titles that slipped through, not by guessing.

const START = '(?<![\\p{L}\\p{N}_])'; // a word start that also works for Cyrillic
const words = (...patterns) => patterns.map((p) => new RegExp(`${START}(?:${p})`, 'iu'));

const FLAG_VERBS = 'снять|снятие|убрать|удалить|выпилить|включить|выключить|отключить|remove|delete|drop|clean\\s*up|enable|disable|turn\\s+(?:on|off)|flip';

const PATTERNS = words(
  // a flag to flip: "снять флаг X", "remove the X flag", "enable feature flag X"
  `(?:${FLAG_VERBS})\\s+(?:\\S+\\s+){0,2}?(?:фич[аеиу]?[- ]?)?флаг|(?:${FLAG_VERBS})\\s+(?:the\\s+|a\\s+)?(?:\\S+\\s+){0,2}?(?:feature\\s+)?flags?(?![\\p{L}])`,
  'flags?\\s+(?:removal|cleanup|clean-up)',
  // after an event
  'после\\s+(?:прод|релиз|тег|выкат|деплой|деплоя|мёрж|мерж|мердж|влития|ответа|снятия\\s+код|код-фриз|раскат)',
  'after\\s+(?:the\\s+)?(?:release|prod|production|tag|rollout|merge|deploy|deployment|backend|code\\s+freeze|answer|reply)',
  'когда\\s+.{0,40}?(?:release\\s+notes|в\\s+проде|на\\s+проде|в\\s+релизе|выкат|смерж|влит)',
  'once\\s+.{0,40}?(?:merged|released|deployed|shipped)',
  // waiting for someone
  'ждём|ждем|дождаться|подождать|ожидаем',
  'wait(?:ing)?\\s+(?:for|on|until)',
  'напомнить|remind(?![\\p{L}])',
  '(?:спросить|уточнить\\s+у|написать|сказать|передать|пингануть|согласовать\\s+с)\\s+(?:бэк|бек|фронт|qa|тестиров|дизайнер|аналитик|продукт|лид|команд|@)',
  '(?:ask|tell|ping|notify|check\\s+with)\\s+(?:the\\s+)?(?:backend|frontend|qa|design|designers?|product|pm|po|lead|team|devops|@)',
);

// "Включить PKB_REPORT_ENABLED по умолчанию": a flag verb followed by a SCREAMING_SNAKE constant (case matters there).
const CONSTANT = new RegExp(`${START}(?:${FLAG_VERBS})\\s+(\\S+)`, 'giu');
const SNAKE = /^[A-Z][A-Z0-9]*_[A-Z0-9_]+$/;

export function isReminderTitle(title) {
  const text = String(title ?? '');
  if (PATTERNS.some((re) => re.test(text))) return true;
  return [...text.matchAll(CONSTANT)].some((m) => SNAKE.test(m[1].replace(/[^\w]+$/, '')));
}
