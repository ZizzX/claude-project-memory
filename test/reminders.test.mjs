import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isReminderTitle } from '../scripts/lib/reminders.mjs';

// Positives: titles from a real board that turned out to be reminders; negatives: ordinary work in the same words.
const REMINDERS = [
  'PDP v3 · снять флаг PDP_V3_ENABLED после прод-тега',
  'ATS-3217: снять флаг части 1 и мёртвую ветку — только после прод-тега, где он true',
  'C2b Снять флаги CANDIDATES_ADVANCED_FILTERS и COLD_SEARCH (кандидаты, холодный поиск)',
  'Включить PKB_REPORT_STATUSES_ENABLED по умолчанию (когда ATS-3150 в release notes)',
  'ATS-3165: включить VACANCIES_COMPANY_MULTI_FILTER_ENABLED по умолчанию после выката бэка ATS-3005 на stage и prod',
  'Влить MR !526 после снятия код-фриза',
  'A2 Удалить мок-страницу /dashboard/hiring-report (после ответа продукта)',
  'Ждём ответ дизайнера по пустому состоянию',
  'Напомнить бэку про пагинацию',
  'Уточнить у бэка формат ошибки',
  'Remove the SEARCH_V2 flag after the prod tag',
  'Enable feature flag NEW_FUNNEL by default',
  'Merge !41 after the release',
  'Wait for the backend to ship the endpoint',
  'Ask the backend team about pagination',
  'Remind QA to retest the export',
  'Drop the workaround once !12 is merged',
];
const WORK = [
  'Под флагом PKB_REPORT_STATUSES_ENABLED вернуть «Открыть» у HALF READY',
  'Поиск в фильтре «Должности» списка вакансий (клиентский, под флагом)',
  'Фокус и объявление после прикрепления строки в модалке стоп-листа',
  'Починить tsc на rc/2.2.0: build падает после !544 (useQuery без generic → data: {})',
  'E2E candidate-tags падают: candidate-tags ждёт метки у первого кандидата',
  'PDP v3 · фундамент: @myhr/data-pdp, флаг PDP_V3_ENABLED, X-Pdp-Unmask: 0 на /api/v3/',
  'Спросить подтверждение перед удалением вакансии',
  'Напоминания кандидатам о собеседовании',
  'Включить фильтр по городу в списке вакансий',
  'Ask for confirmation before deleting a vacancy',
  'Show a flag icon next to the country',
  'Retry the upload after a network error',
  'Waiting spinner on the upload button',
  'Reminder emails for candidates',
];

test('isReminderTitle: reminder wording in Russian and English', () => {
  for (const title of REMINDERS) assert.equal(isReminderTitle(title), true, title);
});

test('isReminderTitle: ordinary work in the same words is not a reminder', () => {
  for (const title of WORK) assert.equal(isReminderTitle(title), false, title);
});
