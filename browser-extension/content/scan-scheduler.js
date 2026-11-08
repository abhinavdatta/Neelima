(() => {
  'use strict';
  // Shared scan scheduler for the provider content scripts.
  //
  // WHY: every provider script used to run a FULL `document.querySelectorAll`
  // pass on every DOM mutation (childList + subtree on <html>). While a model
  // streams, that fires dozens of times per second and each pass also calls
  // `message.textContent`, which serializes the whole subtree. The page then
  // spends CPU re-reading itself while it is trying to render.
  //
  // WHAT THIS DOES: one observer per provider script that
  //   - coalesces all mutations into at most one pass per `intervalMs`,
  //   - processes only the CHANGED nodes (walking added nodes + their matching
  //     descendants) instead of rescanning the document,
  //   - does a full pass only when the transcript structurally changed (a
  //     container swap, a removed node, or the first load),
  //   - ignores mutations caused by Neelima's own controls (marked
  //     `data-neelima-own`), so adding a button cannot re-trigger scanning,
  //   - stays quiet while the tab is hidden and rescans once when it returns.
  //
  // Provider-specific selectors and behaviour stay in each provider script.
  if (window.__NEELIMA_SCAN__) return;

  const OWN_SELECTOR = '[data-neelima-own]';

  function isOwn(node) {
    if (!node || node.nodeType !== 1) return false;
    if (node.matches && node.matches(OWN_SELECTOR)) return true;
    return !!(node.closest && node.closest(OWN_SELECTOR));
  }

  function defaultRoot() {
    // The transcript usually lives in <main>; falls back to body so an SPA
    // container swap cannot leave the observer detached from the page.
    return document.querySelector('main') || document.body;
  }

  window.__NEELIMA_SCAN__ = {
    /**
     * @param {object} options
     * @param {string[]} options.selectors  provider-specific message selectors
     * @param {(el: Element) => void} options.onNode  called for each changed match
     * @param {number} [options.intervalMs]  coalescing window (default 200)
     * @param {() => Element|null} [options.root]  container to observe
     * @returns {{disconnect: () => void, flush: () => void}}
     */
    watch({ selectors, onNode, intervalMs = 200, root = defaultRoot }) {
      const pending = new Set();
      let timer = null;
      let fullScan = false;
      let observer = null;
      let target = null;

      function matches(el) {
        for (const selector of selectors) {
          try {
            if (el.matches && el.matches(selector)) return true;
          } catch (_) {
            /* invalid selector: ignore it, never break the page */
          }
        }
        return false;
      }

      function add(el) {
        if (!el || el.nodeType !== 1 || isOwn(el)) return;
        if (matches(el)) pending.add(el);
        // A batch can add a container holding several messages at once.
        for (const selector of selectors) {
          try {
            el.querySelectorAll(selector).forEach((found) => {
              if (!isOwn(found)) pending.add(found);
            });
          } catch (_) {
            /* ignore invalid selector */
          }
        }
      }

      function collect(el) {
        if (!el || el.nodeType !== 1 || isOwn(el)) return;
        add(el);
        // The interesting node may be an ancestor that just finished rendering
        // (text streamed into a child). Walk up a few levels, never the whole tree.
        let cur = el;
        for (let depth = 0; cur && depth < 4; depth += 1) {
          if (matches(cur) && !isOwn(cur)) pending.add(cur);
          cur = cur.parentElement;
        }
      }

      function flush() {
        timer = null;
        if (document.visibilityState === 'hidden') return; // rescan on return
        const nodes = Array.from(pending);
        pending.clear();
        if (fullScan) {
          fullScan = false;
          for (const selector of selectors) {
            try {
              document.querySelectorAll(selector).forEach((el) => {
                if (!isOwn(el)) nodes.push(el);
              });
            } catch (_) {
              /* ignore invalid selector */
            }
          }
        }
        const seen = new Set();
        for (const el of nodes) {
          if (seen.has(el) || !el.isConnected || isOwn(el)) continue;
          seen.add(el);
          try {
            onNode(el);
          } catch (_) {
            /* one bad node must not stop the rest */
          }
        }
      }

      function schedule(forceFull) {
        if (forceFull) fullScan = true;
        if (timer) return;
        timer = setTimeout(flush, intervalMs);
      }

      function onMutations(records) {
        let structural = false;
        for (const record of records) {
          if (isOwn(record.target)) continue; // our own button/panel appeared
          if (record.type === 'childList') {
            const removed = !!(record.removedNodes && record.removedNodes.length);
            if (removed) structural = true;
            const isTop = record.target === document.body || record.target === document.documentElement;
            if (isTop) structural = true;
            let foreign = false;
            record.addedNodes.forEach((node) => {
              if (node.nodeType === 1) {
                if (!isOwn(node)) foreign = true;
                collect(node);
              } else if (node.nodeType === 3 && String(node.nodeValue || '').trim()) {
                foreign = true; // streamed text
              }
            });
            // Re-examine the container only when something that is NOT our own
            // UI changed inside it. Without this guard, appending our review
            // button would re-run the provider's full message handler (which
            // serializes the message text) on every mutation we cause.
            if (record.target.nodeType === 1 && (foreign || removed)) collect(record.target);
          } else if (record.type === 'attributes' && record.target.nodeType === 1) {
            if (!isOwn(record.target)) collect(record.target);
          } else if (record.type === 'characterData') {
            // Streamed text: re-examine the owning message, coalesced like
            // everything else, so a completed tool block still gets a button.
            const parent = record.target && record.target.parentElement;
            if (parent && !isOwn(parent)) collect(parent);
          }
        }
        if (pending.size || structural) schedule(structural);
      }

      function attach() {
        const next = (typeof root === 'function' ? root() : root) || document.body;
        if (!next || next === target) return;
        if (observer) observer.disconnect();
        target = next;
        observer = new MutationObserver(onMutations);
        observer.observe(target, {
          childList: true,
          subtree: true,
          attributes: true,
          characterData: true,
        });
      }

      attach();
      // If <main> did not exist yet, upgrade the observer once it does.
      if (!target || target === document.body) {
        setTimeout(() => {
          if (target === document.body) attach();
        }, 1500);
      }
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState !== 'hidden') schedule(true);
      });

      schedule(true); // first pass over already-rendered messages

      return {
        disconnect() {
          if (observer) observer.disconnect();
          if (timer) clearTimeout(timer);
        },
        flush() {
          if (timer) {
            clearTimeout(timer);
            timer = null;
          }
          flush();
        },
      };
    },
  };
})();
