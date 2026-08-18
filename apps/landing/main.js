/**
 * Oven landing page — all of the behaviour, in one file, with no dependencies.
 *
 * Everything here degrades safely: with JS disabled the page is fully readable, every link
 * works, and the only losses are the scroll animations and the copy button.
 */
;(() => {
  'use strict'

  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches

  /* --- sticky nav ------------------------------------------------------ */
  const nav = document.getElementById('nav')
  if (nav) {
    const onScroll = () => nav.classList.toggle('stuck', window.scrollY > 12)
    onScroll()
    addEventListener('scroll', onScroll, { passive: true })
  }

  /* --- mobile menu ----------------------------------------------------- */
  const toggle = document.getElementById('nav-toggle')
  const links = document.getElementById('nav-links')
  if (toggle && links) {
    toggle.addEventListener('click', () => {
      const open = links.classList.toggle('open')
      toggle.setAttribute('aria-expanded', String(open))
    })
    // Close after navigating, otherwise the menu covers the anchor you just jumped to.
    links.addEventListener('click', (event) => {
      if (event.target.closest('a')) {
        links.classList.remove('open')
        toggle.setAttribute('aria-expanded', 'false')
      }
    })
  }

  /* --- copy the install command ---------------------------------------- */
  for (const button of document.querySelectorAll('.copy')) {
    button.addEventListener('click', async () => {
      const text = button.dataset.copy
      try {
        await navigator.clipboard.writeText(text)
      } catch {
        // Clipboard API needs a secure context and permission; fall back to a hidden
        // textarea so the button still does something useful over plain http.
        const scratch = document.createElement('textarea')
        scratch.value = text
        scratch.setAttribute('readonly', '')
        scratch.style.cssText = 'position:absolute;left:-9999px'
        document.body.appendChild(scratch)
        scratch.select()
        document.execCommand('copy')
        scratch.remove()
      }
      button.classList.add('done')
      setTimeout(() => button.classList.remove('done'), 1600)
    })
  }

  /* --- reveal on scroll ------------------------------------------------ */
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
      { rootMargin: '0px 0px -12% 0px', threshold: 0.08 },
    )
    for (const element of revealables) observer.observe(element)
  }

  /* --- benchmark bars --------------------------------------------------
   * Held at zero width until the chart scrolls into view, so the numbers animate up rather
   * than being already drawn when the reader arrives.
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
            // A beat after the reveal transition so the two do not fight each other.
            setTimeout(() => bars.classList.add('run'), 180)
            barObserver.disconnect()
          }
        },
        { threshold: 0.3 },
      )
      barObserver.observe(bars)
    }
  }
})()
