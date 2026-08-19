/**
 * Oven — landing page behaviour.
 *
 * Four small things: a border on the nav once you scroll, copy-to-clipboard, the code tabs, and
 * reveal-on-scroll. No framework and no build step — the page works without any of it.
 */
;(() => {
  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches

  /* --- nav border on scroll ------------------------------------------- */
  const nav = document.getElementById('nav')
  if (nav) {
    const sync = () => nav.classList.toggle('scrolled', window.scrollY > 8)
    sync()
    window.addEventListener('scroll', sync, { passive: true })
  }

  /* --- copy to clipboard ----------------------------------------------- */
  for (const button of document.querySelectorAll('.copy')) {
    button.addEventListener('click', async () => {
      const text = button.dataset.copy
      if (!text) return

      try {
        await navigator.clipboard.writeText(text)
      } catch {
        // Clipboard access can be refused — over http, or by permission. Falling back to a
        // selection means the reader can still press cmd-C rather than being told nothing.
        const field = document.createElement('textarea')
        field.value = text
        field.setAttribute('readonly', '')
        field.style.cssText = 'position:fixed;top:-1000px'
        document.body.append(field)
        field.select()
        try {
          document.execCommand('copy')
        } finally {
          field.remove()
        }
      }

      button.classList.add('done')
      setTimeout(() => button.classList.remove('done'), 1600)
    })
  }

  /* --- code tabs -------------------------------------------------------
   * Panels are in the markup and only hidden, so every example is in the page source for
   * search engines and for anyone with JavaScript off.
   */
  const tabs = [...document.querySelectorAll('.tab')]
  if (tabs.length > 0) {
    const select = (tab) => {
      for (const other of tabs) {
        const selected = other === tab
        other.setAttribute('aria-selected', String(selected))
        const panel = document.getElementById(other.getAttribute('aria-controls'))
        if (panel) panel.hidden = !selected
      }
    }

    for (const [index, tab] of tabs.entries()) {
      tab.addEventListener('click', () => select(tab))

      // Arrow keys move between tabs, which is what the tablist role promises.
      tab.addEventListener('keydown', (event) => {
        const step = event.key === 'ArrowRight' ? 1 : event.key === 'ArrowLeft' ? -1 : 0
        if (step === 0) return
        event.preventDefault()
        const next = tabs[(index + step + tabs.length) % tabs.length]
        next.focus()
        select(next)
      })
    }
  }

  /* --- reveal on scroll -------------------------------------------------
   * threshold 0 with a negative bottom margin, rather than a visibility ratio: a section taller
   * than the viewport can never reach a ratio like 0.08, and would stay invisible forever.
   */
  const revealables = document.querySelectorAll('.reveal')

  if (reduced || !('IntersectionObserver' in window)) {
    for (const element of revealables) element.classList.add('in')
  } else {
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (!entry.isIntersecting) continue
          entry.target.classList.add('in')
          observer.unobserve(entry.target)
        }
      },
      { rootMargin: '0px 0px -10% 0px', threshold: 0 },
    )
    for (const element of revealables) observer.observe(element)
  }

  /* --- benchmark bars --------------------------------------------------
   * Held at zero width until the chart is in view, so the numbers grow rather than being
   * already drawn when the reader arrives.
   */
  const bars = document.getElementById('bars')
  if (bars) {
    if (reduced || !('IntersectionObserver' in window)) {
      bars.classList.add('run')
    } else {
      const barObserver = new IntersectionObserver(
        (entries) => {
          for (const entry of entries) {
            if (!entry.isIntersecting) continue
            setTimeout(() => bars.classList.add('run'), 150)
            barObserver.disconnect()
          }
        },
        { threshold: 0.25 },
      )
      barObserver.observe(bars)
    }
  }
})()
