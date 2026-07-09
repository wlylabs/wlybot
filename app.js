(function () {
  'use strict';

  var chatEl = document.getElementById('chat');
  var inputEl = document.getElementById('input');
  var sendBtn = document.getElementById('send');
  var micBtn = document.getElementById('mic');
  var statusEl = document.getElementById('status');
  var backdropEl = document.getElementById('sheet-backdrop');

  var STORAGE_CHATS = 'wlybot.chats';
  var STORAGE_ACTIVE = 'wlybot.active';
  var STORAGE_LEGACY = 'wlybot.messages';
  var STORAGE_PROVIDER = 'wlybot.provider';

  var PROVIDER_LABELS = [
    { id: 'auto', name: 'Automatic (recommended)', desc: 'Groq first; falls back to Gemini, then OpenRouter' },
    { id: 'groq', name: 'Groq', desc: 'Llama 3.3 70B, very fast responses' },
    { id: 'gemini', name: 'Gemini', desc: 'Google Gemini 2.5 Flash' },
    { id: 'openrouter', name: 'OpenRouter', desc: 'Llama 3.3 70B (free tier)' }
  ];

  var busy = false;
  var abortCtrl = null;

  /* ---------- Multi-chat state ---------- */
  function uid() {
    return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  }

  var chats = [];
  try {
    chats = JSON.parse(localStorage.getItem(STORAGE_CHATS) || '[]');
    if (!Array.isArray(chats)) chats = [];
  } catch (e) { chats = []; }
  chats = chats.filter(function (c) {
    return c && typeof c.id === 'string' && Array.isArray(c.messages);
  });

  // Migrate the pre-multi-chat single history into a conversation.
  try {
    var legacy = JSON.parse(localStorage.getItem(STORAGE_LEGACY) || '[]');
    if (Array.isArray(legacy) && legacy.length) {
      var firstUser = null;
      for (var li = 0; li < legacy.length; li++) {
        if (legacy[li].role === 'user') { firstUser = legacy[li].content; break; }
      }
      chats.unshift({ id: uid(), title: (firstUser || 'Chat').slice(0, 60), messages: legacy, updated: Date.now() });
      localStorage.removeItem(STORAGE_LEGACY);
    }
  } catch (e) {}

  var current = null;
  var activeId = localStorage.getItem(STORAGE_ACTIVE);
  for (var ci = 0; ci < chats.length; ci++) {
    if (chats[ci].id === activeId) { current = chats[ci]; break; }
  }
  if (!current) current = { id: uid(), title: '', messages: [], updated: Date.now() };
  var messages = current.messages;

  function persist() {
    try {
      var out = chats
        .filter(function (c) { return c.messages.length > 0; })
        .sort(function (a, b) { return (b.updated || 0) - (a.updated || 0); })
        .slice(0, 30)
        .map(function (c) {
          return { id: c.id, title: c.title, updated: c.updated, messages: c.messages.slice(-60) };
        });
      localStorage.setItem(STORAGE_CHATS, JSON.stringify(out));
      localStorage.setItem(STORAGE_ACTIVE, current.id);
    } catch (e) {}
  }

  function sortedChats() {
    return chats
      .filter(function (c) { return c.messages.length > 0; })
      .sort(function (a, b) { return (b.updated || 0) - (a.updated || 0); });
  }

  function newChat() {
    if (busy) return;
    if (messages.length === 0) { closeSheets(); return; }
    current = { id: uid(), title: '', messages: [], updated: Date.now() };
    messages = current.messages;
    persist();
    renderAll();
    closeSheets();
  }

  function openChat(id) {
    if (busy) return;
    for (var i = 0; i < chats.length; i++) {
      if (chats[i].id === id) {
        current = chats[i];
        messages = current.messages;
        persist();
        renderAll();
        closeSheets();
        return;
      }
    }
  }

  function deleteChat(id) {
    if (busy) return;
    showConfirm('Delete this conversation?', 'Delete', function () {
      for (var i = 0; i < chats.length; i++) {
        if (chats[i].id === id) { chats.splice(i, 1); break; }
      }
      if (current.id === id) {
        current = { id: uid(), title: '', messages: [], updated: Date.now() };
        messages = current.messages;
        renderAll();
      }
      persist();
      renderChats();
    });
  }

  function getProvider() {
    return localStorage.getItem(STORAGE_PROVIDER) || 'auto';
  }

  /* Follow the stream only while the user is at the bottom; never yank
     them back down after they scroll up to read. */
  var autoScroll = true;
  var jumpBtn = document.getElementById('jump');

  chatEl.addEventListener('scroll', function () {
    var dist = chatEl.scrollHeight - chatEl.scrollTop - chatEl.clientHeight;
    autoScroll = dist < 60;
    jumpBtn.classList.toggle('show', dist > 160);
  });

  function scrollToBottom(force) {
    if (force) autoScroll = true;
    if (autoScroll) chatEl.scrollTop = chatEl.scrollHeight;
  }

  jumpBtn.addEventListener('click', function () {
    autoScroll = true;
    chatEl.scrollTo({ top: chatEl.scrollHeight, behavior: 'smooth' });
  });

  /* ---------- Lightweight markdown ---------- */
  function escapeHtml(s) {
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  function renderInline(s) {
    return s
      .replace(/`([^`]+)`/g, function (_, c) { return '<code>' + c + '</code>'; })
      .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
      .replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>')
      .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
  }

  function renderMarkdown(raw) {
    var text = escapeHtml(raw);
    var parts = text.split(/```/);
    var html = '';
    for (var i = 0; i < parts.length; i++) {
      if (i % 2 === 1) {
        var langMatch = parts[i].match(/^([a-zA-Z0-9+_-]*)\n/);
        var lang = langMatch && langMatch[1] ? langMatch[1] : 'code';
        var code = parts[i].replace(/^[a-zA-Z0-9+_-]*\n/, '');
        html += '<div class="codeblock">' +
          '<div class="codebar"><span class="codelang">' + lang + '</span></div>' +
          '<pre><code>' + code + '</code></pre>' +
        '</div>';
      } else {
        html += renderBlocks(parts[i]);
      }
    }
    return html;
  }

  function renderBlocks(text) {
    var lines = text.split('\n');
    var html = '';
    var para = [];
    var stack = [];  // open list types, outermost first
    var liOpen = []; // whether an <li> is still open at each depth

    function flushPara() {
      if (para.length) {
        html += '<p>' + renderInline(para.join('<br>')) + '</p>';
        para = [];
      }
    }
    function closeItem() {
      if (liOpen.length && liOpen[liOpen.length - 1]) {
        html += '</li>';
        liOpen[liOpen.length - 1] = false;
      }
    }
    function closeList() {
      closeItem();
      html += '</' + stack.pop() + '>';
      liOpen.pop();
    }
    function closeAllLists() {
      while (stack.length) closeList();
    }

    function isTableRow(s) { return /^\s*\|.*\|\s*$/.test(s); }
    function isTableSep(s) { return /^\s*\|?[\s:|-]+\|?\s*$/.test(s) && s.indexOf('-') !== -1; }
    function splitRow(s) {
      var cells = s.replace(/^\s*\|/, '').replace(/\|\s*$/, '').split('|');
      for (var c = 0; c < cells.length; c++) cells[c] = cells[c].trim();
      return cells;
    }

    for (var i = 0; i < lines.length; i++) {
      var line = lines[i];

      if (isTableRow(line) && i + 1 < lines.length && isTableSep(lines[i + 1])) {
        flushPara(); closeAllLists();
        var head = splitRow(line);
        html += '<div class="tablewrap"><table><thead><tr>';
        for (var hc = 0; hc < head.length; hc++) html += '<th>' + renderInline(head[hc]) + '</th>';
        html += '</tr></thead><tbody>';
        i += 2;
        while (i < lines.length && isTableRow(lines[i])) {
          var cells = splitRow(lines[i]);
          html += '<tr>';
          for (var cc = 0; cc < head.length; cc++) html += '<td>' + renderInline(cells[cc] || '') + '</td>';
          html += '</tr>';
          i++;
        }
        i--; // the for-loop increment moves past the last table row
        html += '</tbody></table></div>';
        continue;
      }

      var h = line.match(/^(#{1,3})\s+(.*)/);
      var li = line.match(/^(\s*)([-*]|\d+[.)])\s+(.*)/);
      // The source is HTML-escaped before parsing, so ">" arrives as "&gt;".
      var bq = line.match(/^&gt;\s?(.*)/);

      if (h) {
        flushPara(); closeAllLists();
        var lvl = h[1].length;
        html += '<h' + lvl + '>' + renderInline(h[2]) + '</h' + lvl + '>';
      } else if (li) {
        flushPara();
        var want = /^\d/.test(li[2]) ? 'ol' : 'ul';
        // Two spaces of indent per level; never jump deeper than one new level.
        var depth = Math.min(Math.floor(li[1].length / 2), stack.length, 3);
        while (stack.length > depth + 1) closeList();
        if (stack.length === depth + 1 && stack[depth] !== want) closeList();
        if (stack.length < depth + 1) {
          // A nested list opens inside the still-open parent <li>.
          html += '<' + want + '>';
          stack.push(want);
          liOpen.push(false);
        }
        closeItem();
        html += '<li>' + renderInline(li[3]);
        liOpen[liOpen.length - 1] = true;
      } else if (bq) {
        flushPara(); closeAllLists();
        html += '<blockquote>' + renderInline(bq[1]) + '</blockquote>';
      } else if (line.trim() === '') {
        flushPara(); closeAllLists();
      } else {
        closeAllLists();
        para.push(line);
      }
    }
    flushPara(); closeAllLists();
    return html;
  }

  /* ---------- Clipboard ---------- */
  function copyText(text, btn) {
    function done() {
      if (!btn) return;
      var old = btn.textContent;
      btn.textContent = 'copied';
      btn.classList.add('done');
      setTimeout(function () {
        btn.textContent = old;
        btn.classList.remove('done');
      }, 1200);
    }
    function fallback() {
      var ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      try { document.execCommand('copy'); } catch (e) {}
      ta.remove();
    }
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(done, function () { fallback(); done(); });
    } else {
      fallback(); done();
    }
  }

  /* ---------- Run Python in-browser (Pyodide) ---------- */
  var PYODIDE_CDN = 'https://cdn.jsdelivr.net/pyodide/v0.27.2/full/';
  var RUNNABLE_LANGS = { python: 1, py: 1, python3: 1 };
  var pyodidePromise = null;
  var pyRunning = false;

  function getPyodide() {
    if (!pyodidePromise) {
      pyodidePromise = new Promise(function (resolve, reject) {
        var s = document.createElement('script');
        s.src = PYODIDE_CDN + 'pyodide.js';
        s.onload = function () {
          window.loadPyodide({ indexURL: PYODIDE_CDN }).then(resolve, reject);
        };
        s.onerror = function () {
          reject(new Error('Could not load the Python runtime. Check your connection and try again.'));
        };
        document.head.appendChild(s);
      });
      pyodidePromise.catch(function () { pyodidePromise = null; });
    }
    return pyodidePromise;
  }

  function runPython(block, btn) {
    if (pyRunning) return;
    pyRunning = true;

    var codeEl = block.querySelector('code');
    var source = (codeEl ? codeEl.textContent : '').replace(/\n$/, '');

    var out = block.querySelector('.code-out');
    if (!out) {
      out = document.createElement('div');
      out.className = 'code-out';
      out.innerHTML = '<div class="code-out-head"><span class="code-out-dot"></span>' +
        '<span class="code-out-label">OUTPUT</span><span class="code-out-meta"></span></div><pre></pre>';
      block.appendChild(out);
    }
    var label = out.querySelector('.code-out-label');
    var meta = out.querySelector('.code-out-meta');
    var body = out.querySelector('pre');

    out.className = 'code-out running';
    label.textContent = pyodidePromise ? 'RUNNING' : 'LOADING PYTHON…';
    meta.textContent = '';
    body.textContent = '';
    btn.disabled = true;
    btn.textContent = 'running';

    function write(line) { body.textContent += line + '\n'; }
    function finish(state, labelText, t0) {
      out.className = 'code-out ' + state;
      label.textContent = labelText;
      if (t0) meta.textContent = ((performance.now() - t0) / 1000).toFixed(2) + 's';
      btn.disabled = false;
      btn.textContent = 'run';
      pyRunning = false;
    }

    getPyodide().then(function (py) {
      label.textContent = 'RUNNING';
      py.setStdout({ batched: write });
      py.setStderr({ batched: write });
      var t0 = performance.now();
      py.runPythonAsync(source).then(function (result) {
        if (result !== undefined) write(String(result));
        finish('ok', 'DONE', t0);
      }, function (err) {
        body.textContent = String(err && err.message ? err.message : err);
        finish('err', 'ERROR', t0);
      });
    }, function (err) {
      body.textContent = String(err && err.message ? err.message : err);
      finish('err', 'ERROR');
    });
  }

  /* ---------- Message rendering ---------- */
  function addBubble(role, content) {
    var el = document.createElement('div');
    el.className = 'msg ' + role;
    if (role === 'bot') el.innerHTML = renderMarkdown(content);
    else el.textContent = content;
    chatEl.appendChild(el);
    scrollToBottom(true);
    return el;
  }

  function addCodeCopies(el) {
    var blocks = el.querySelectorAll('.codeblock');
    for (var i = 0; i < blocks.length; i++) {
      (function (block) {
        var bar = block.querySelector('.codebar');
        if (!bar || bar.querySelector('.code-copy')) return;
        var btn = document.createElement('button');
        btn.className = 'code-copy';
        btn.textContent = 'copy';
        btn.addEventListener('click', function () {
          var code = block.querySelector('code');
          copyText((code ? code.textContent : block.textContent).replace(/\n$/, ''), btn);
        });
        bar.appendChild(btn);
        var langEl = bar.querySelector('.codelang');
        var lang = langEl ? langEl.textContent.trim().toLowerCase() : '';
        if (RUNNABLE_LANGS[lang]) {
          var runBtn = document.createElement('button');
          runBtn.className = 'code-run';
          runBtn.textContent = 'run';
          runBtn.addEventListener('click', function () { runPython(block, runBtn); });
          bar.appendChild(runBtn);
        }
      })(blocks[i]);
    }
  }

  function removeRegenButtons() {
    var olds = chatEl.querySelectorAll('.act-regen');
    for (var i = 0; i < olds.length; i++) olds[i].remove();
  }

  function decorateBot(el, raw, canRegen) {
    addCodeCopies(el);
    removeRegenButtons();
    var row = document.createElement('div');
    row.className = 'msg-actions';
    var c = document.createElement('button');
    c.className = 'act';
    c.textContent = 'copy';
    c.addEventListener('click', function () { copyText(raw, c); });
    row.appendChild(c);
    if (canRegen) {
      var r = document.createElement('button');
      r.className = 'act act-regen';
      r.textContent = 'regen';
      r.addEventListener('click', regenerate);
      row.appendChild(r);
    }
    el.appendChild(row);
  }

  var SUGGESTION_POOL = [
    [ // coding
      'Explain REST vs GraphQL in 3 sentences',
      'Write a regex that validates Indonesian phone numbers',
      'Debug: why does my useEffect run twice?',
      'Write a JavaScript function to validate an email'
    ],
    [ // creative
      'Write an Instagram caption for a coffee brand',
      'Give me 5 name ideas for a tech podcast',
      'Write a punchy tagline for a portfolio site',
      'Turn "monday meeting" into a haiku'
    ],
    [ // productivity
      'Summarize this article into 5 bullet points:',
      'Draft a polite follow-up email to a client',
      'Plan my week with time blocks',
      'Turn these notes into a to-do list:'
    ]
  ];

  function pickSuggestions() {
    var picks = [];
    for (var i = 0; i < SUGGESTION_POOL.length; i++) {
      var cat = SUGGESTION_POOL[i];
      picks.push(cat[Math.floor(Math.random() * cat.length)]);
    }
    // shuffle so category order also varies
    for (var j = picks.length - 1; j > 0; j--) {
      var k = Math.floor(Math.random() * (j + 1));
      var t = picks[j]; picks[j] = picks[k]; picks[k] = t;
    }
    return picks;
  }

  function showEmptyState() {
    var picks = pickSuggestions();
    var sugHtml = '';
    for (var s = 0; s < picks.length; s++) {
      sugHtml += '<button class="suggestion">' + escapeHtml(picks[s]) + '</button>';
    }
    chatEl.innerHTML =
      '<div class="empty-state">' +
        '<div class="term-box">' +
          '<span class="term-box-title">WLYB0T <span class="v">v1.0</span></span>' +
          '<div class="term-cols">' +
            '<div class="term-left">' +
              '<p class="term-welcome">Welcome back!</p>' +
              '<div class="brand-mark"><span class="wm-seg" data-text="WLYB">WLYB</span><span class="wm-seg o" data-text="0">0</span><span class="wm-seg" data-text="T">T</span></div>' +
              '<p class="term-meta">multi-provider &middot; streaming</p>' +
              '<p class="term-meta">voice input &middot; no tracking</p>' +
            '</div>' +
            '<div class="term-tips">' +
              '<h4>Tips for getting started</h4>' +
              '<p>Ask anything &mdash; code, drafts, ideas, or explanations. Chats stay on this device.</p>' +
              '<div class="suggestions">' + sugHtml + '</div>' +
            '</div>' +
          '</div>' +
        '</div>' +
      '</div>';
    var btns = chatEl.querySelectorAll('.suggestion');
    for (var i = 0; i < btns.length; i++) {
      btns[i].addEventListener('click', function () {
        inputEl.value = this.textContent;
        onInput();
        // Prompts ending with ":" expect pasted content — fill the input instead of sending.
        if (/:$/.test(this.textContent)) { inputEl.focus(); return; }
        sendMessage();
      });
    }
  }

  function renderAll() {
    chatEl.innerHTML = '';
    if (messages.length === 0) { showEmptyState(); return; }
    for (var i = 0; i < messages.length; i++) {
      var m = messages[i];
      var el = addBubble(m.role === 'user' ? 'user' : 'bot', m.content);
      if (m.role !== 'user') decorateBot(el, m.content, i === messages.length - 1);
    }
  }

  /* ---------- Send & streaming ---------- */
  var statusFlashTimer = null;
  function setStatus(text) {
    if (statusFlashTimer) { clearTimeout(statusFlashTimer); statusFlashTimer = null; }
    statusEl.textContent = text;
  }
  function flashStatus(text, ms) {
    setStatus(text);
    statusFlashTimer = setTimeout(function () {
      statusFlashTimer = null;
      statusEl.textContent = busy ? 'streaming_' : 'ready';
    }, ms);
  }

  function setBusy(v) {
    busy = v;
    setStatus(v ? 'thinking_' : 'ready');
    sendBtn.classList.toggle('busy', v);
    sendBtn.setAttribute('aria-label', v ? 'Stop' : 'Send');
    updateSendState();
  }

  function updateSendState() {
    // While busy the button stays enabled so streaming can be stopped.
    sendBtn.disabled = !busy && inputEl.value.trim() === '';
  }

  function requestCompletion() {
    var convo = messages; // capture: user may not switch chats while busy, but be safe
    setBusy(true);

    var botEl = document.createElement('div');
    botEl.className = 'msg bot';
    botEl.innerHTML = '<span class="cursor-blink"></span>';
    chatEl.appendChild(botEl);
    scrollToBottom(true);

    abortCtrl = new AbortController();
    var acc = '';

    fetch('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: abortCtrl.signal,
      body: JSON.stringify({ messages: convo, provider: getProvider() })
    }).then(function (res) {
      if (!res.ok) {
        return res.json().then(function (data) {
          throw new Error(data.error || 'Something went wrong (' + res.status + ')');
        }, function () {
          throw new Error('Something went wrong (' + res.status + ')');
        });
      }
      var reader = res.body.getReader();
      var decoder = new TextDecoder();
      function pump() {
        return reader.read().then(function (r) {
          if (r.done) {
            acc += decoder.decode();
            return;
          }
          acc += decoder.decode(r.value, { stream: true });
          if (statusEl.textContent === 'thinking_') setStatus('streaming_');
          botEl.innerHTML = renderMarkdown(acc);
          scrollToBottom();
          return pump();
        });
      }
      return pump();
    }).then(function () {
      finish();
    }).catch(function (err) {
      if (err.name === 'AbortError') { finish(); return; }
      botEl.remove();
      addBubble('error', err.message);
      setBusy(false);
      flashStatus('error_', 3000);
    });

    function finish() {
      if (acc.trim() === '') {
        botEl.remove();
        addBubble('error', 'No response from the model. Try again or switch providers in settings.');
        setBusy(false);
        flashStatus('error_', 3000);
        scrollToBottom();
        return;
      } else {
        convo.push({ role: 'assistant', content: acc });
        current.updated = Date.now();
        persist();
        botEl.innerHTML = renderMarkdown(acc);
        decorateBot(botEl, acc, convo === messages);
      }
      setBusy(false);
      scrollToBottom();
    }
  }

  function sendMessage() {
    var text = inputEl.value.trim();
    if (!text || busy) return;

    if (messages.length === 0) chatEl.innerHTML = '';
    removeRegenButtons();

    if (chats.indexOf(current) === -1) chats.unshift(current);
    if (!current.title) current.title = text.slice(0, 60);
    current.updated = Date.now();

    messages.push({ role: 'user', content: text });
    persist();
    addBubble('user', text);

    inputEl.value = '';
    onInput();
    requestCompletion();
  }

  function regenerate() {
    if (busy) return;
    if (!messages.length || messages[messages.length - 1].role !== 'assistant') return;
    messages.pop();
    current.updated = Date.now();
    persist();
    var bots = chatEl.querySelectorAll('.msg.bot');
    if (bots.length) bots[bots.length - 1].remove();
    requestCompletion();
  }

  /* ---------- Input ---------- */
  function onInput() {
    inputEl.style.height = 'auto';
    inputEl.style.height = Math.min(inputEl.scrollHeight, 120) + 'px';
    updateSendState();
  }
  inputEl.addEventListener('input', onInput);
  inputEl.addEventListener('keydown', function (e) {
    if (e.key === 'Enter' && !e.shiftKey && window.matchMedia('(min-width: 700px)').matches) {
      e.preventDefault();
      sendMessage();
    }
  });
  sendBtn.addEventListener('click', function () {
    if (busy) {
      if (abortCtrl) abortCtrl.abort();
    } else {
      sendMessage();
    }
  });

  /* ---------- Voice input (Web Speech API) ---------- */
  var SRec = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SRec) {
    micBtn.style.display = 'none';
  } else {
    var rec = null;
    var recActive = false;
    var recBase = '';
    micBtn.addEventListener('click', function () {
      if (recActive) {
        try { rec.stop(); } catch (e) {}
        return;
      }
      rec = new SRec();
      rec.lang = navigator.language || 'id-ID';
      rec.interimResults = true;
      recBase = inputEl.value ? inputEl.value.replace(/\s+$/, '') + ' ' : '';
      rec.onresult = function (e) {
        var t = '';
        for (var i = 0; i < e.results.length; i++) t += e.results[i][0].transcript;
        inputEl.value = recBase + t;
        onInput();
      };
      rec.onend = function () {
        recActive = false;
        micBtn.classList.remove('rec');
        updateSendState();
      };
      rec.onerror = function () {};
      try {
        rec.start();
        recActive = true;
        micBtn.classList.add('rec');
      } catch (e) {}
    });
  }

  /* ---------- Export ---------- */
  function exportChat() {
    if (!messages.length) {
      closeSheets();
      flashStatus('nothing to export_', 2000);
      return;
    }
    var lines = ['# Wlybot chat', ''];
    for (var i = 0; i < messages.length; i++) {
      var m = messages[i];
      lines.push((m.role === 'user' ? '**You:**' : '**Wlybot:**') + '\n\n' + m.content);
      lines.push('');
    }
    var blob = new Blob([lines.join('\n')], { type: 'text/markdown' });
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'wlybot-chat-' + new Date().toISOString().slice(0, 10) + '.md';
    a.click();
    setTimeout(function () { URL.revokeObjectURL(a.href); }, 1000);
  }

  /* ---------- Confirm modal ---------- */
  var confirmModal = document.getElementById('confirm-modal');
  var confirmBox = confirmModal.querySelector('.modal-box');
  var confirmTextEl = document.getElementById('confirm-text');
  var confirmOkBtn = document.getElementById('confirm-ok');
  var confirmCancelBtn = document.getElementById('confirm-cancel');
  var confirmCb = null;
  var confirmLastFocus = null;

  function showConfirm(msg, okLabel, cb) {
    confirmTextEl.textContent = msg;
    confirmOkBtn.textContent = okLabel;
    confirmCb = cb;
    confirmLastFocus = document.activeElement;
    document.body.classList.add('confirm-open');
    confirmCancelBtn.focus();
  }
  function closeConfirm(accepted) {
    document.body.classList.remove('confirm-open');
    var cb = confirmCb;
    confirmCb = null;
    if (confirmLastFocus) {
      try { confirmLastFocus.focus(); } catch (e) {}
      confirmLastFocus = null;
    }
    if (accepted && cb) cb();
  }
  confirmOkBtn.addEventListener('click', function () { closeConfirm(true); });
  confirmCancelBtn.addEventListener('click', function () { closeConfirm(false); });
  confirmModal.addEventListener('click', function (e) {
    if (e.target === confirmModal) closeConfirm(false);
  });

  /* ---------- Bottom sheets ---------- */
  function renderProviders() {
    var list = document.getElementById('provider-list');
    var currentProvider = getProvider();
    list.innerHTML = '';
    PROVIDER_LABELS.forEach(function (p) {
      var btn = document.createElement('button');
      btn.className = 'provider-option' + (p.id === currentProvider ? ' selected' : '');
      btn.innerHTML = '<span class="radio"></span><span>' + p.name + '<small>' + p.desc + '</small></span>';
      btn.addEventListener('click', function () {
        localStorage.setItem(STORAGE_PROVIDER, p.id);
        renderProviders();
        closeSheets();
      });
      list.appendChild(btn);
    });
  }

  function fmtDate(ts) {
    var d = new Date(ts || 0);
    var now = new Date();
    if (d.toDateString() === now.toDateString()) {
      return ('0' + d.getHours()).slice(-2) + ':' + ('0' + d.getMinutes()).slice(-2);
    }
    return ('0' + d.getDate()).slice(-2) + '/' + ('0' + (d.getMonth() + 1)).slice(-2);
  }

  function renderChats() {
    var list = document.getElementById('chats-list');
    list.innerHTML = '';
    var sorted = sortedChats();
    if (!sorted.length) {
      list.innerHTML = '<div class="chats-empty">no conversations yet</div>';
      return;
    }
    sorted.forEach(function (c) {
      var row = document.createElement('div');
      row.className = 'chat-row';

      var item = document.createElement('button');
      item.className = 'chat-item' + (c.id === current.id ? ' active' : '');
      var t = document.createElement('span');
      t.className = 't';
      t.textContent = c.title || 'Chat';
      var d = document.createElement('span');
      d.className = 'd';
      d.textContent = fmtDate(c.updated) + ' · ' + c.messages.length + ' msg';
      item.appendChild(t);
      item.appendChild(d);
      item.addEventListener('click', function () { openChat(c.id); });

      var del = document.createElement('button');
      del.className = 'chat-del';
      del.setAttribute('aria-label', 'Delete conversation');
      del.textContent = '×';
      del.addEventListener('click', function () { deleteChat(c.id); });

      row.appendChild(item);
      row.appendChild(del);
      list.appendChild(row);
    });
  }

  var settingsSheet = document.getElementById('sheet');
  var chatsSheet = document.getElementById('chats-sheet');
  var sheetLastFocus = null;

  function openSheet(sheetEl, cls) {
    closeSheets();
    sheetLastFocus = document.activeElement;
    document.body.classList.add(cls);
    sheetEl.focus();
  }
  function openSettings() { renderProviders(); openSheet(settingsSheet, 'sheet-open'); }
  function openChats() { renderChats(); openSheet(chatsSheet, 'chats-open'); }
  function closeSheets() {
    var wasOpen = document.body.classList.contains('sheet-open') ||
      document.body.classList.contains('chats-open');
    document.body.classList.remove('sheet-open');
    document.body.classList.remove('chats-open');
    if (wasOpen && sheetLastFocus) {
      try { sheetLastFocus.focus(); } catch (e) {}
      sheetLastFocus = null;
    }
  }

  function activeOverlay() {
    if (document.body.classList.contains('confirm-open')) return confirmBox;
    if (document.body.classList.contains('sheet-open')) return settingsSheet;
    if (document.body.classList.contains('chats-open')) return chatsSheet;
    return null;
  }

  function trapFocus(container, e) {
    var items = container.querySelectorAll('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])');
    if (!items.length) { e.preventDefault(); return; }
    var first = items[0];
    var last = items[items.length - 1];
    var active = document.activeElement;
    if (!container.contains(active)) { e.preventDefault(); first.focus(); }
    else if (e.shiftKey && (active === first || active === container)) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && active === last) { e.preventDefault(); first.focus(); }
  }

  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape') {
      if (document.body.classList.contains('confirm-open')) { closeConfirm(false); return; }
      closeSheets();
      return;
    }
    if (e.key === 'Tab') {
      var overlay = activeOverlay();
      if (overlay) trapFocus(overlay, e);
    }
  });

  // Swipe down on a sheet to dismiss it, matching the drag handle's affordance.
  function makeSwipeable(sheetEl) {
    var startY = 0, delta = 0, dragging = false;
    var scroller = sheetEl.querySelector('#chats-list');
    sheetEl.addEventListener('touchstart', function (e) {
      dragging = true;
      startY = e.touches[0].clientY;
      delta = 0;
    }, { passive: true });
    sheetEl.addEventListener('touchmove', function (e) {
      if (!dragging) return;
      if (scroller && scroller.contains(e.target) && scroller.scrollTop > 0) {
        dragging = false;
        sheetEl.style.transition = '';
        sheetEl.style.transform = '';
        return;
      }
      delta = e.touches[0].clientY - startY;
      if (delta > 0) {
        sheetEl.style.transition = 'none';
        sheetEl.style.transform = 'translateY(' + delta + 'px)';
      }
    }, { passive: true });
    sheetEl.addEventListener('touchend', function () {
      if (!dragging) return;
      dragging = false;
      sheetEl.style.transition = '';
      sheetEl.style.transform = '';
      if (delta > 70) closeSheets();
    });
  }
  makeSwipeable(settingsSheet);
  makeSwipeable(chatsSheet);
  document.getElementById('settings-btn').addEventListener('click', openSettings);
  document.getElementById('history-btn').addEventListener('click', openChats);
  document.getElementById('new-btn').addEventListener('click', newChat);
  document.getElementById('sheet-new-btn').addEventListener('click', newChat);
  document.getElementById('export-btn').addEventListener('click', exportChat);
  backdropEl.addEventListener('click', closeSheets);

  document.getElementById('clear-btn').addEventListener('click', function () {
    showConfirm('Delete this chat?', 'Delete', function () {
      messages.splice(0, messages.length);
      current.title = '';
      persist();
      closeSheets();
      renderAll();
    });
  });

  /* ---------- Init ---------- */
  renderAll();
  scrollToBottom();
})();
