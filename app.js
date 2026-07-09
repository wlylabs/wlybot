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
    if (!confirm('Delete this conversation?')) return;
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
  }

  function getProvider() {
    return localStorage.getItem(STORAGE_PROVIDER) || 'auto';
  }

  function scrollToBottom() {
    chatEl.scrollTop = chatEl.scrollHeight;
  }

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
    var listType = null; // 'ul' | 'ol'
    var para = [];

    function flushPara() {
      if (para.length) {
        html += '<p>' + renderInline(para.join('<br>')) + '</p>';
        para = [];
      }
    }
    function closeList() {
      if (listType) { html += '</' + listType + '>'; listType = null; }
    }

    for (var i = 0; i < lines.length; i++) {
      var line = lines[i];
      var h = line.match(/^(#{1,3})\s+(.*)/);
      var ul = line.match(/^\s*[-*]\s+(.*)/);
      var ol = line.match(/^\s*\d+[.)]\s+(.*)/);
      var bq = line.match(/^>\s?(.*)/);

      if (h) {
        flushPara(); closeList();
        var lvl = h[1].length;
        html += '<h' + lvl + '>' + renderInline(h[2]) + '</h' + lvl + '>';
      } else if (ul || ol) {
        flushPara();
        var want = ul ? 'ul' : 'ol';
        if (listType !== want) { closeList(); html += '<' + want + '>'; listType = want; }
        html += '<li>' + renderInline((ul || ol)[1]) + '</li>';
      } else if (bq) {
        flushPara(); closeList();
        html += '<blockquote>' + renderInline(bq[1]) + '</blockquote>';
      } else if (line.trim() === '') {
        flushPara(); closeList();
      } else {
        closeList();
        para.push(line);
      }
    }
    flushPara(); closeList();
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

  /* ---------- Message rendering ---------- */
  function addBubble(role, content) {
    var el = document.createElement('div');
    el.className = 'msg ' + role;
    if (role === 'bot') el.innerHTML = renderMarkdown(content);
    else el.textContent = content;
    chatEl.appendChild(el);
    scrollToBottom();
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
        '<div class="brand-mark"><span class="wm-seg" data-text="WLYB">WLYB</span><span class="wm-seg o" data-text="0">0</span><span class="wm-seg" data-text="T">T</span></div>' +
        '<h2>An AI assistant <span class="hl">you own</span>.</h2>' +
        '<p>Any model. Every question. Zero friction.</p>' +
        '<div class="suggestions">' + sugHtml + '</div>' +
        '<div class="empty-feats">' +
          '<span>multi-provider</span>' +
          '<span>streaming</span>' +
          '<span>voice input</span>' +
          '<span>no tracking</span>' +
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
    scrollToBottom();

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
      alert('Nothing to export yet.');
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

  function openSettings() { closeSheets(); renderProviders(); document.body.classList.add('sheet-open'); }
  function openChats() { closeSheets(); renderChats(); document.body.classList.add('chats-open'); }
  function closeSheets() {
    document.body.classList.remove('sheet-open');
    document.body.classList.remove('chats-open');
  }
  document.getElementById('settings-btn').addEventListener('click', openSettings);
  document.getElementById('history-btn').addEventListener('click', openChats);
  document.getElementById('new-btn').addEventListener('click', newChat);
  document.getElementById('sheet-new-btn').addEventListener('click', newChat);
  document.getElementById('export-btn').addEventListener('click', exportChat);
  backdropEl.addEventListener('click', closeSheets);

  document.getElementById('clear-btn').addEventListener('click', function () {
    if (!confirm('Delete this chat?')) return;
    messages.splice(0, messages.length);
    current.title = '';
    persist();
    closeSheets();
    renderAll();
  });

  /* ---------- Init ---------- */
  renderAll();
  scrollToBottom();
})();
