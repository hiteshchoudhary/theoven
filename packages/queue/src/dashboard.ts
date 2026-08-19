import type { JobRecord, QueueStats } from './types'

export interface DashboardData {
  driver: string
  stats: QueueStats
  dead: JobRecord[]
  jobs: string[]
  cron: Array<{ name: string; schedule: string; job: string; next: string }>
}

/**
 * The development queue dashboard.
 *
 * Hand-written HTML with inline styles, for the same reasons as the mail inbox: it must work
 * with no build step and no network, and it must not add a dependency to a package whose job is
 * running background work.
 *
 * Everything interpolated is escaped. A dead-lettered job's `lastError` contains whatever the
 * failure produced, and some of that started as user input.
 */
export function renderDashboard(data: DashboardData): string {
  const cards = [
    ['Ready', data.stats.ready],
    ['Scheduled', data.stats.scheduled],
    ['Active', data.stats.active],
    ['Dead', data.stats.dead],
  ]
    .map(
      ([label, value]) =>
        `<div class="card"><span class="value">${value}</span><span class="label">${label}</span></div>`,
    )
    .join('')

  const dead =
    data.dead.length === 0
      ? '<p class="empty">Nothing has been given up on.</p>'
      : `<table>
          <thead><tr><th>Job</th><th>Attempts</th><th>Failed with</th></tr></thead>
          <tbody>${data.dead
            .map(
              (record) => `<tr>
                <td><code>${escape(record.name)}</code><div class="id">${escape(record.id)}</div></td>
                <td>${record.attempts}</td>
                <td class="error">${escape(record.lastError ?? '—')}</td>
              </tr>`,
            )
            .join('')}</tbody>
        </table>`

  const cron =
    data.cron.length === 0
      ? '<p class="empty">No scheduled jobs.</p>'
      : `<table>
          <thead><tr><th>Name</th><th>Schedule</th><th>Job</th><th>Next</th></tr></thead>
          <tbody>${data.cron
            .map(
              (entry) => `<tr>
                <td>${escape(entry.name)}</td>
                <td><code>${escape(entry.schedule)}</code></td>
                <td><code>${escape(entry.job)}</code></td>
                <td><time datetime="${escape(entry.next)}">${escape(entry.next.replace('T', ' ').slice(0, 16))}</time></td>
              </tr>`,
            )
            .join('')}</tbody>
        </table>`

  const registered =
    data.jobs.length === 0
      ? '<p class="empty">No jobs registered.</p>'
      : `<ul class="jobs">${data.jobs.map((name) => `<li><code>${escape(name)}</code></li>`).join('')}</ul>`

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="refresh" content="5">
<title>Queue — Oven</title>
<style>
  :root { color-scheme: light dark; --line: #8883; --dim: #8888; }
  * { box-sizing: border-box; }
  body { margin: 0; padding: 2rem 1.5rem; font: 15px/1.6 ui-sans-serif, system-ui, sans-serif;
         max-width: 62rem; margin-inline: auto; }
  header { border-bottom: 1px solid var(--line); padding-bottom: 1rem; margin-bottom: 1.5rem; }
  h1 { font-size: 1.4rem; margin: 0 0 .25rem; }
  header p { margin: 0; color: var(--dim); font-size: .9rem; }
  .cards { display: grid; grid-template-columns: repeat(auto-fit, minmax(8rem, 1fr));
           gap: .75rem; margin-bottom: 2rem; }
  .card { border: 1px solid var(--line); border-radius: 10px; padding: 1rem; display: flex;
          flex-direction: column; gap: .1rem; }
  .value { font-size: 1.75rem; font-weight: 600; line-height: 1.1; }
  .label { color: var(--dim); font-size: .8rem; text-transform: uppercase; letter-spacing: .06em; }
  h2 { font-size: .8rem; text-transform: uppercase; letter-spacing: .06em; color: var(--dim);
       margin: 2rem 0 .5rem; }
  table { border-collapse: collapse; width: 100%; font-size: .9rem; }
  th { text-align: left; color: var(--dim); font-weight: 500; border-bottom: 1px solid var(--line);
       padding: .4rem .5rem .4rem 0; }
  td { padding: .5rem .5rem .5rem 0; border-bottom: 1px solid var(--line); vertical-align: top; }
  code { font-size: .85em; background: #8881; padding: .1rem .35rem; border-radius: 4px; }
  .id { color: var(--dim); font-size: .75rem; margin-top: .2rem; font-family: ui-monospace, monospace; }
  .error { color: #d33; word-break: break-word; }
  .empty { color: var(--dim); }
  .jobs { list-style: none; padding: 0; margin: 0; display: flex; flex-wrap: wrap; gap: .4rem; }
</style>
</head>
<body>
  <header>
    <h1>Queue</h1>
    <p>Driver: <code>${escape(data.driver)}</code> — development only, refreshes every 5s.</p>
  </header>
  <div class="cards">${cards}</div>
  <h2>Dead letter</h2>
  ${dead}
  <h2>Scheduled</h2>
  ${cron}
  <h2>Registered jobs</h2>
  ${registered}
</body>
</html>`
}

function escape(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}
