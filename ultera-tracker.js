/**
 * ULTERA Shape — Live Analytics Tracker
 * Sends events to Supabase: clicks, scroll depth, mouse heatmap,
 * section dwell time, funnel steps, device info
 */
(function() {
  'use strict';

  // ── Supabase config ──
  const SUPABASE_URL  = 'https://fsihlzzjewhxpogvjapu.supabase.co';
  const SUPABASE_KEY  = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImZzaWhsenpqZXdoeHBvZ3ZqYXB1Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzUyOTY2MzUsImV4cCI6MjA5MDg3MjYzNX0._hS7TA8EqIHgz7CH6XxGKuDdOnVBb6u40ntEtZ__MjU';
  const TABLE         = 'analytics_events';
  const BATCH_MS      = 3000;       // flush every 3s
  const MOUSE_MS      = 200;        // sample mouse every 200ms
  const SCROLL_MS     = 500;        // sample scroll every 500ms
  const SECTION_MIN   = 1000;       // min dwell 1s to count a section view

  // ── Session ──
  const sid = (() => {
    let s = sessionStorage.getItem('_ut_sid');
    if (!s) { s = Date.now().toString(36) + Math.random().toString(36).slice(2,8); sessionStorage.setItem('_ut_sid', s); }
    return s;
  })();

  // ── Device detection ──
  const vw = () => window.innerWidth;
  const vh = () => window.innerHeight;
  const deviceType = () => vw() < 768 ? 'mobile' : vw() < 1024 ? 'tablet' : 'desktop';

  // ── Event queue & flush ──
  let queue = [];

  function enqueue(eventType, eventData) {
    queue.push({
      session_id: sid,
      event_type: eventType,
      event_data: eventData,
      page_url: location.href,
      viewport_w: vw(),
      viewport_h: vh(),
      screen_w: screen.width,
      screen_h: screen.height,
      device_type: deviceType(),
      user_agent: navigator.userAgent,
      referrer: document.referrer || null
    });
  }

  function flush() {
    if (!queue.length) return;
    const batch = queue.splice(0, queue.length);
    // Use sendBeacon for reliability, fallback to fetch
    const url = SUPABASE_URL + '/rest/v1/' + TABLE;
    const headers = {
      'Content-Type': 'application/json',
      'apikey': SUPABASE_KEY,
      'Authorization': 'Bearer ' + SUPABASE_KEY,
      'Prefer': 'return=minimal'
    };
    const body = JSON.stringify(batch);

    if (navigator.sendBeacon) {
      const blob = new Blob([body], { type: 'application/json' });
      // sendBeacon can't set custom headers, use fetch
    }
    fetch(url, { method: 'POST', headers: headers, body: body, keepalive: true }).catch(() => {});
  }

  setInterval(flush, BATCH_MS);

  // ── 1. PAGE VIEW ──
  enqueue('page_view', {
    title: document.title,
    timestamp: new Date().toISOString()
  });

  // ── 2. CLICK TRACKING ──
  document.addEventListener('click', function(e) {
    const rect = document.documentElement.getBoundingClientRect();
    const x_pct = ((e.clientX) / vw() * 100).toFixed(2);
    const y_abs = e.pageY;
    const y_pct = (e.pageY / document.documentElement.scrollHeight * 100).toFixed(2);

    // Identify clicked element
    const el = e.target;
    const tag = el.tagName.toLowerCase();
    const classes = el.className && typeof el.className === 'string' ? el.className.slice(0, 120) : '';
    const text = (el.textContent || '').trim().slice(0, 60);
    const id = el.id || '';
    const href = el.closest('a') ? el.closest('a').href : '';
    const section = closestSection(el);

    enqueue('click', {
      x_pct: +x_pct,
      y_pct: +y_pct,
      y_abs: y_abs,
      tag: tag,
      id: id,
      classes: classes,
      text: text,
      href: href,
      section: section
    });

    // Funnel tracking for key actions
    if (el.closest('.cta-main, .cta-hero, [onclick*="scrollToOrder"], .order-btn, .btn-order') ||
        text.match(/замовити|купити|оформити|order/i)) {
      funnelStep('cta_click', section);
    }
    if (el.closest('#productCardView, .product-card')) {
      funnelStep('product_interact');
    }
  }, true);

  // ── 3. SCROLL DEPTH ──
  let maxScroll = 0;
  let scrollTimer = null;

  window.addEventListener('scroll', function() {
    if (scrollTimer) return;
    scrollTimer = setTimeout(function() {
      scrollTimer = null;
      const scrollTop = window.pageYOffset || document.documentElement.scrollTop;
      const docHeight = document.documentElement.scrollHeight - vh();
      const pct = docHeight > 0 ? Math.round(scrollTop / docHeight * 100) : 0;

      if (pct > maxScroll) {
        // Record milestones: 25, 50, 75, 90, 100
        const milestones = [25, 50, 75, 90, 100];
        for (let m of milestones) {
          if (pct >= m && maxScroll < m) {
            enqueue('scroll', { depth_pct: m, scroll_px: scrollTop });
          }
        }
        maxScroll = pct;
      }
    }, SCROLL_MS);
  }, { passive: true });

  // ── 4. MOUSE HEATMAP (sampled) ──
  let mouseX = 0, mouseY = 0, mouseMoved = false;

  document.addEventListener('mousemove', function(e) {
    mouseX = e.pageX;
    mouseY = e.pageY;
    mouseMoved = true;
  }, { passive: true });

  setInterval(function() {
    if (!mouseMoved) return;
    mouseMoved = false;
    const x_pct = (mouseX / Math.max(document.documentElement.scrollWidth, 1) * 100).toFixed(1);
    const y_pct = (mouseY / Math.max(document.documentElement.scrollHeight, 1) * 100).toFixed(1);
    enqueue('mouse_move', {
      x_pct: +x_pct,
      y_pct: +y_pct,
      x_abs: mouseX,
      y_abs: mouseY
    });
  }, MOUSE_MS);

  // ── 5. SECTION DWELL TIME (Intersection Observer) ──
  const sectionTimers = {};  // sectionId -> { start, total }

  function setupSectionTracking() {
    const sections = document.querySelectorAll('section, .hero, [id="velcroFit"], [id="advantages"], [id="order"]');
    if (!sections.length) return;

    const obs = new IntersectionObserver(function(entries) {
      entries.forEach(function(entry) {
        const id = sectionName(entry.target);
        if (!sectionTimers[id]) sectionTimers[id] = { start: null, total: 0, reported: false };

        if (entry.isIntersecting) {
          sectionTimers[id].start = Date.now();
          if (!sectionTimers[id].reported) {
            sectionTimers[id].reported = true;
            enqueue('section_view', { section: id, first_view: true });
            funnelStep('section_' + id);
          }
        } else if (sectionTimers[id].start) {
          const dwell = Date.now() - sectionTimers[id].start;
          sectionTimers[id].total += dwell;
          sectionTimers[id].start = null;
          if (dwell >= SECTION_MIN) {
            enqueue('section_dwell', { section: id, dwell_ms: dwell, total_ms: sectionTimers[id].total });
          }
        }
      });
    }, { threshold: 0.3 });

    sections.forEach(function(s) { obs.observe(s); });
  }

  // ── 6. FUNNEL ──
  const funnelSteps = [];

  function funnelStep(step, detail) {
    if (funnelSteps.includes(step)) return; // deduplicate
    funnelSteps.push(step);
    enqueue('funnel_step', {
      step: step,
      step_index: funnelSteps.length,
      detail: detail || null,
      timestamp: new Date().toISOString()
    });
  }

  // Auto-detect form opens and submissions
  const formObserver = new MutationObserver(function(mutations) {
    mutations.forEach(function(m) {
      m.addedNodes.forEach(function(n) {
        if (n.nodeType === 1) {
          if (n.classList && (n.classList.contains('checkout') || n.classList.contains('order-form') || n.id === 'checkoutModal')) {
            funnelStep('form_open');
          }
        }
      });
    });
  });
  formObserver.observe(document.body, { childList: true, subtree: true });

  // Listen for form submits
  document.addEventListener('submit', function(e) {
    funnelStep('form_submit');
  }, true);

  // ── 7. PAGE LEAVE ──
  function onLeave() {
    // Final dwell times
    for (const id in sectionTimers) {
      if (sectionTimers[id].start) {
        sectionTimers[id].total += Date.now() - sectionTimers[id].start;
        sectionTimers[id].start = null;
      }
    }

    const totalTime = Date.now() - performance.timing.navigationStart;
    enqueue('page_leave', {
      total_time_ms: totalTime,
      max_scroll_pct: maxScroll,
      funnel_steps: funnelSteps,
      section_times: Object.fromEntries(
        Object.entries(sectionTimers).map(([k, v]) => [k, v.total])
      )
    });
    flush();
  }

  window.addEventListener('beforeunload', onLeave);
  document.addEventListener('visibilitychange', function() {
    if (document.visibilityState === 'hidden') onLeave();
  });

  // ── Helpers ──
  function closestSection(el) {
    const s = el.closest('section, .hero');
    return s ? sectionName(s) : 'unknown';
  }

  function sectionName(el) {
    if (el.id) return el.id;
    if (el.classList.contains('hero')) return 'hero';
    const label = el.querySelector('.section-label');
    if (label) return label.textContent.trim().toLowerCase().replace(/\s+/g, '_');
    return 'section_' + [...el.parentElement.children].indexOf(el);
  }

  // ── Init ──
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function() {
      setupSectionTracking();
      funnelStep('page_view');
    });
  } else {
    setupSectionTracking();
    funnelStep('page_view');
  }

})();
