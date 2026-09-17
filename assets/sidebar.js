'use strict';

(() => {
  const vscode = acquireVsCodeApi();
  const saved = vscode.getState() || {};
  const elements = Object.fromEntries([
    'account-panel', 'account-name', 'account-plan', 'account-expiry', 'account-note', 'refresh', 'usage',
    'credits', 'credits-count', 'global-error', 'new-tab', 'search', 'threads-status', 'thread-list', 'load-more',
  ].map((id) => [id, document.getElementById(id)]));
  let state = {};
  let searchTimer;
  let scrollTimer;
  let restoringScroll = true;
  let resetPendingId;
  let usageExpanded = saved.usageExpanded === true;
  let creditsExpanded = saved.creditsExpanded === true;
  let threadDay = new Date().toDateString();
  let threadSignature;
  let threadMenu;
  let menuReturnFocus;
  // 与官方侧栏套餐标签表对齐；不推导受实验开关控制的 Pro 等级。
  const planLabels = new Map([
    ['pro', 'Pro'], ['prolite', 'Pro'], ['team', 'Business'],
    ['self_serve_business_prolite', 'Business'], ['self_serve_business_usage_based', 'Business'],
  ]);
  const text = (value, fallback = '') => typeof value === 'string' && value.trim() ? value : fallback;
  const items = (value) => Array.isArray(value) ? value : [];
  const timestamp = (value) => typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null;
  const send = (type, fields = {}) => vscode.postMessage({ type, ...fields });

  function node(tag, className, content) {
    const element = document.createElement(tag);
    if (className) element.className = className;
    if (content !== undefined) element.textContent = content;
    return element;
  }

  function notice(element, message) {
    element.textContent = message;
    element.hidden = !message;
  }

  function date(value) {
    const seconds = timestamp(value);
    if (!seconds) return '';
    const parsed = new Date(seconds * 1000);
    if (!Number.isFinite(parsed.getTime())) return '';
    return parsed.toLocaleString('zh-CN', { year: 'numeric', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });
  }

  function resetTime(value) {
    if (!date(value)) return '官方未提供重置时间';
    const minutes = Math.ceil((value * 1000 - Date.now()) / 60000);
    if (minutes <= 0) return `${date(value)} · 等待官方刷新`;
    const days = Math.floor(minutes / 1440);
    const hours = Math.floor((minutes % 1440) / 60);
    const remainder = minutes % 60;
    const countdown = [days ? `${days} 天` : '', hours ? `${hours} 小时` : '', !days && remainder ? `${remainder} 分钟` : ''].filter(Boolean).join(' ');
    return `${date(value)} 重置 · 约 ${countdown || '1 分钟'} 后`;
  }

  function persist() {
    vscode.setState({
      query: elements.search.value,
      scrollTop: restoringScroll ? Number(saved.scrollTop) || 0 : window.scrollY,
      accountExpanded: elements['account-panel'].open,
      usageExpanded,
      creditsExpanded,
    });
  }

  function renderUsage() {
    const usage = state.usage || {};
    const container = elements.usage;
    container.replaceChildren();
    if (usage.status !== 'ready') {
      container.append(node('p', 'notice', text(usage.message, '暂无法读取官方用量')));
      return;
    }
    const windows = items(usage.windows).filter((entry) => entry && typeof entry === 'object');
    if (!windows.length) container.append(node('p', 'notice', text(usage.message, '官方未提供用量窗口')));
    const more = node('details', 'usage-more');
    more.open = usageExpanded;
    const summary = node('summary', '', usageExpanded ? '收起' : '显示更多');
    const extraWindows = node('div', 'usage-extra');
    more.append(summary, extraWindows);
    more.addEventListener('toggle', () => {
      if (!more.isConnected) return;
      usageExpanded = more.open;
      summary.textContent = usageExpanded ? '收起' : '显示更多';
      persist();
    });
    for (const entry of windows) {
      const row = node('div', 'usage-window');
      const heading = node('div', 'usage-heading');
      heading.append(node('span', '', text(entry.label, '用量窗口')));
      const valid = typeof entry.usedPercent === 'number' && Number.isFinite(entry.usedPercent);
      heading.append(node('span', 'usage-value', valid ? `已用 ${Math.round(entry.usedPercent)}%` : '用量未知'));
      row.append(heading);
      if (valid) {
        const progress = node('progress', entry.usedPercent >= 90 ? 'usage-progress near-limit' : 'usage-progress');
        progress.max = 100;
        progress.value = Math.max(0, Math.min(100, entry.usedPercent));
        progress.setAttribute('aria-label', `${text(entry.label, '用量窗口')}已用 ${Math.round(entry.usedPercent)}%`);
        row.append(progress);
      }
      const timing = node('p', 'reset-time', resetTime(entry.resetsAt));
      if (timestamp(entry.resetsAt)) timing.dataset.resetsAt = String(entry.resetsAt);
      row.append(timing);
      const extra = /gpt[\s_-]*5\.3|codex[\s_-]*spark/i.test(`${text(entry.label)} ${text(entry.id)}`);
      (extra ? extraWindows : container).append(row);
    }
    if (extraWindows.childElementCount) container.append(more);
  }

  function updateCreditCount() {
    const credits = state.credits || {};
    const cards = items(credits.items).filter((entry) => entry && typeof entry === 'object');
    const expired = cards.filter((entry) => entry.available === true && timestamp(entry.expiresAt) && entry.expiresAt * 1000 <= Date.now()).length;
    const officialCount = Number.isSafeInteger(credits.availableCount) && credits.availableCount >= 0;
    const count = officialCount ? Math.max(0, credits.availableCount - expired)
      : credits.status === 'ready' && Array.isArray(credits.items)
        ? cards.filter((entry) => entry.available === true).length - expired : null;
    elements['credits-count'].textContent = count === null ? '—' : `${count} 张可用`;
    elements['credits-count'].title = count === null ? '官方暂未提供可用卡数量' : `全部额度重置卡中可用 ${count} 张`;
  }

  function renderCredits() {
    const credits = state.credits || {};
    const container = elements.credits;
    container.replaceChildren();
    updateCreditCount();
    if (credits.status !== 'ready') {
      container.append(node('p', 'notice', text(credits.message, '暂无法读取重置卡')));
      return;
    }
    if (!Array.isArray(credits.items)) {
      container.append(node('p', 'notice', text(credits.message, '官方未提供重置卡详情')));
      return;
    }
    const cards = items(credits.items).filter((entry) => entry && typeof entry === 'object');
    if (!cards.length) container.append(node('p', 'notice', credits.availableCount > 0 ? '官方未提供重置卡详情' : '暂无额度重置卡'));
    const cardElements = [];
    for (const [index, entry] of cards.entries()) {
      const card = node('div', 'credit-card');
      card.hidden = index >= 2 && !creditsExpanded;
      cardElements.push(card);
      const info = node('div', 'credit-info');
      const heading = node('div', 'credit-heading');
      heading.append(node('strong', '', text(entry.title, '额度重置卡')));
      const expired = timestamp(entry.expiresAt) && entry.expiresAt * 1000 <= Date.now();
      const available = entry.available === true && !expired;
      if (timestamp(entry.expiresAt) && !expired) card.dataset.expiresAt = String(entry.expiresAt);
      heading.append(node('span', available ? 'badge available' : 'badge', expired ? '已失效' : available ? '可用' : '不可用'));
      const expires = date(entry.expiresAt);
      const expiryDate = expires ? new Date(entry.expiresAt * 1000) : null;
      const shortExpiry = expiryDate ? expiryDate.toLocaleDateString('zh-CN', {
        ...(expiryDate.getFullYear() !== new Date().getFullYear() ? { year: 'numeric' } : {}),
        month: 'numeric', day: 'numeric',
      }) : '';
      const expiry = node('p', 'muted', shortExpiry ? `${shortExpiry} 到期` : '到期时间未知');
      expiry.title = expires ? `${expires} 失效` : '官方未提供失效日期';
      info.append(heading, expiry);
      card.append(info);
      const busy = credits.busyId === entry.id || resetPendingId === entry.id;
      const button = node('button', 'reset-credit', busy ? '处理中' : '重置');
      button.setAttribute('aria-label', `${busy ? '正在处理' : '重置额度'}：${text(entry.title, '额度重置卡')}`);
      button.disabled = !available || !text(entry.id) || !state.capabilities?.reset || Boolean(credits.busyId || resetPendingId);
      if (!state.capabilities?.reset) button.title = '当前官方接口不支持额度重置';
      button.addEventListener('click', () => {
        resetPendingId = entry.id;
        renderCredits();
        send('resetCredit', { creditId: entry.id });
      });
      card.append(button);
      container.append(card);
    }
    if (cards.length > 2) {
      const more = node('button', 'credits-more', creditsExpanded ? '收起' : '查看更多');
      more.setAttribute('aria-expanded', String(creditsExpanded));
      more.addEventListener('click', () => {
        creditsExpanded = !creditsExpanded;
        cardElements.forEach((card, index) => { card.hidden = index >= 2 && !creditsExpanded; });
        more.textContent = creditsExpanded ? '收起' : '查看更多';
        more.setAttribute('aria-expanded', String(creditsExpanded));
        persist();
      });
      container.append(more);
    }
  }

  function action(label, symbol, handler, disabled) {
    const button = node('button', 'icon-button thread-action', symbol);
    button.title = label;
    button.setAttribute('aria-label', label);
    button.disabled = disabled;
    button.addEventListener('click', handler);
    return button;
  }

  function closeThreadMenu(restoreFocus = false) {
    if (!threadMenu) return;
    threadMenu.remove();
    threadMenu = undefined;
    if (restoreFocus && menuReturnFocus?.isConnected) menuReturnFocus.focus();
    menuReturnFocus = undefined;
  }

  function stopThread(entry) {
    if (entry.isRunning !== true || !text(entry.runningTurnId) || !state.capabilities?.stop || entry.stopping) return;
    send('stopThread', { threadId: entry.id, turnId: entry.runningTurnId });
  }

  function showThreadMenu(event, entry, open) {
    event.preventDefault();
    closeThreadMenu();
    const menu = node('div', 'thread-menu');
    menu.setAttribute('role', 'menu');
    menu.tabIndex = -1;
    menu.setAttribute('aria-label', `会话操作：${text(entry.title, '未命名会话')}`);
    const commands = [
      [entry.isPinned ? '取消置顶' : '置顶', () => send('togglePin', { threadId: entry.id }), !state.capabilities?.pin || !text(entry.id)],
      ['重命名', () => send('renameThread', { threadId: entry.id }), !text(entry.id)],
    ];
    if (entry.isRunning === true) commands.push([
      entry.stopping ? '停止中…' : '停止当前轮次', () => stopThread(entry),
      !state.capabilities?.stop || !text(entry.runningTurnId) || !text(entry.id) || Boolean(entry.stopping),
    ]);
    for (const [label, handler, disabled] of commands) {
      const button = node('button', 'thread-menu-item', label);
      button.setAttribute('role', 'menuitem');
      button.disabled = disabled;
      button.addEventListener('click', () => {
        closeThreadMenu(true);
        handler();
      });
      menu.append(button);
    }
    threadMenu = menu;
    menuReturnFocus = open;
    document.body.append(menu);
    const anchor = open.getBoundingClientRect();
    const x = event.type === 'keydown' ? anchor.left : event.clientX;
    const y = event.type === 'keydown' ? anchor.bottom : event.clientY;
    const rect = menu.getBoundingClientRect();
    menu.style.left = `${Math.max(4, Math.min(x, window.innerWidth - rect.width - 4))}px`;
    menu.style.top = `${Math.max(4, Math.min(y, window.innerHeight - rect.height - 4))}px`;
    const buttons = [...menu.querySelectorAll('button')].filter((button) => !button.disabled);
    (buttons[0] || menu).focus();
    menu.addEventListener('keydown', (keyEvent) => {
      if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(keyEvent.key) || !buttons.length) return;
      keyEvent.preventDefault();
      const index = buttons.indexOf(document.activeElement);
      const next = keyEvent.key === 'Home' ? 0 : keyEvent.key === 'End' ? buttons.length - 1
        : (index + (keyEvent.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length;
      buttons[next].focus();
    });
  }

  function renderThreads() {
    const threads = state.threads || {};
    const list = elements['thread-list'];
    closeThreadMenu();
    list.replaceChildren();
    const entries = items(threads.items).filter((entry) => entry && typeof entry === 'object');
    notice(elements['threads-status'], text(threads.error) || (threads.loading ? '正在读取会话…' : entries.length ? '' : elements.search.value ? '没有找到匹配会话' : '暂无会话，开始一个新会话吧'));
    elements['threads-status'].classList.toggle('error', Boolean(threads.error));
    const dayStart = new Date();
    threadDay = dayStart.toDateString();
    dayStart.setHours(0, 0, 0, 0);
    const dayEnd = new Date(dayStart);
    dayEnd.setDate(dayEnd.getDate() + 1);
    const groups = [['置顶', []], ['当日会话', []], ['近期会话', []]];
    for (const entry of entries) {
      const updatedAt = timestamp(entry.updatedAt);
      const today = updatedAt !== null && updatedAt >= dayStart.getTime() / 1000 && updatedAt < dayEnd.getTime() / 1000;
      groups[entry.isPinned ? 0 : today ? 1 : 2][1].push(entry);
    }
    for (const [label, group] of groups) {
      if (!group.length) continue;
      const section = node('section', 'thread-group');
      section.setAttribute('aria-label', label);
      section.append(node('h2', 'group-heading', `${label} · ${group.length}`));
      for (const entry of group) {
        const pinned = Boolean(entry.isPinned);
        const title = text(entry.title, '未命名会话');
        const row = node('div', 'thread-row');
        const open = node('button', 'thread-open');
        open.disabled = !state.capabilities?.open || !text(entry.id);
        open.title = [title, text(entry.preview), text(entry.cwd)].filter(Boolean).join('\n');
        open.setAttribute('aria-label', `${entry.isOpen ? '定位已打开的' : '打开'}会话：${title}`);
        const heading = node('span', 'thread-title', title);
        open.append(heading);
        if (entry.isOpen) open.append(node('span', 'open-indicator', '已打开'));
        const metadata = [date(entry.updatedAt), text(entry.cwd)].filter(Boolean).join(' · ');
        if (metadata) open.append(node('span', 'thread-meta', metadata));
        open.addEventListener('click', () => send('openThread', { threadId: entry.id }));
        row.addEventListener('contextmenu', (event) => showThreadMenu(event, entry, open));
        row.addEventListener('keydown', (event) => {
          if (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10')) showThreadMenu(event, entry, open);
        });
        if (entry.isRunning === true) {
          const running = node('span', 'thread-running');
          const label = entry.stopping ? '停止中…' : '运行中';
          running.title = label;
          running.setAttribute('role', 'status');
          running.setAttribute('aria-label', label);
          running.append(node('span', 'running-spinner'));
          if (entry.stopping) {
            row.classList.toggle('is-stopping', true);
            running.append(node('span', 'running-label', '停止中'));
          }
          row.append(running);
        }
        const actions = node('div', 'thread-actions');
        const pin = action(`${pinned ? '取消置顶' : '置顶'}：${title}`, '', () => send('togglePin', { threadId: entry.id }), !state.capabilities?.pin || !text(entry.id));
        pin.setAttribute('aria-pressed', String(pinned));
        const pinIcon = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
        pinIcon.setAttribute('class', 'pin-icon');
        pinIcon.setAttribute('viewBox', '0 0 16 16');
        pinIcon.setAttribute('aria-hidden', 'true');
        pinIcon.setAttribute('focusable', 'false');
        const pinHead = document.createElementNS('http://www.w3.org/2000/svg', 'path');
        pinHead.setAttribute('d', 'M5 2h6v2h-1v3l2 2v1H4V9l2-2V4H5Z');
        pinHead.setAttribute('fill', pinned ? 'currentColor' : 'none');
        const pinStem = document.createElementNS('http://www.w3.org/2000/svg', 'path');
        pinStem.setAttribute('d', 'M8 10v5');
        pinStem.setAttribute('fill', 'none');
        pinIcon.append(pinHead, pinStem);
        pin.append(pinIcon);
        actions.append(pin, action(`重命名：${title}`, '✎', () => send('renameThread', { threadId: entry.id }), !text(entry.id)));
        if (entry.isRunning === true) {
          const stop = action(`${entry.stopping ? '停止中…' : '停止当前轮次'}：${title}`, '', () => stopThread(entry),
            !state.capabilities?.stop || !text(entry.runningTurnId) || !text(entry.id) || Boolean(entry.stopping));
          stop.append(node('span', 'stop-icon'));
          actions.append(stop);
        }
        row.append(open, actions);
        section.append(row);
      }
      list.append(section);
    }
    elements['load-more'].hidden = !threads.hasMore;
    elements['load-more'].disabled = Boolean(threads.loading);
    elements['load-more'].textContent = threads.loading ? '正在加载…' : '加载更多';
  }

  function render() {
    const account = state.account || {};
    elements['account-name'].textContent = text(account.email, text(account.message, account.status === 'signed-out' ? '尚未登录 Codex' : account.status === 'ready' ? 'API Key 登录' : '账号信息暂不可用'));
    const planType = text(account.planType);
    const planLabel = planLabels.get(planType) || (planType === 'unknown' ? '未知（unknown）'
      : ['free', 'go', 'plus'].includes(planType) ? `${planType[0].toUpperCase()}${planType.slice(1)}`
        : `${planType}（官方类型）`);
    elements['account-plan'].textContent = account.status === 'signed-out' ? '登录后查看套餐'
      : account.status === 'ready' && /API\s*Key/i.test(text(account.message)) ? 'API Key 按量计费'
        : planType ? `当前套餐：${planLabel}` : '套餐信息暂不可用';
    notice(elements['account-expiry'], date(account.expiresAt) ? `账号到期：${date(account.expiresAt)}` : '');
    notice(elements['account-note'], text(account.message));
    notice(elements['global-error'], text(state.error));
    elements.refresh.disabled = Boolean(state.loading);
    elements.refresh.classList.toggle('is-loading', Boolean(state.loading));
    renderUsage();
    renderCredits();
    // 账号定时刷新会传来深拷贝状态；仅会话内容或操作权限变化时重建列表。
    const nextThreadSignature = JSON.stringify([
      state.threads || {}, Boolean(state.capabilities?.pin), Boolean(state.capabilities?.open), Boolean(state.capabilities?.stop), elements.search.value,
    ]);
    if (nextThreadSignature !== threadSignature) {
      renderThreads();
      threadSignature = nextThreadSignature;
    }
  }

  document.addEventListener('pointerdown', (event) => {
    if (threadMenu && !threadMenu.contains(event.target)) closeThreadMenu();
  });
  document.addEventListener('keydown', (event) => {
    if (!threadMenu) return;
    if (event.key === 'Escape') {
      event.preventDefault();
      closeThreadMenu(true);
    } else if (event.key === 'Tab') closeThreadMenu(true);
  });
  window.addEventListener('blur', () => closeThreadMenu());
  window.addEventListener('resize', () => closeThreadMenu(true));
  window.addEventListener('scroll', () => closeThreadMenu(), true);

  elements.search.value = text(saved.query);
  elements['account-panel'].open = saved.accountExpanded !== false;
  elements.search.addEventListener('input', () => {
    persist();
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => {
      searchTimer = undefined;
      send('search', { query: elements.search.value });
    }, 200);
  });
  elements['account-panel'].addEventListener('toggle', persist);
  elements.refresh.addEventListener('click', () => { elements.refresh.disabled = true; send('refresh'); });
  elements['new-tab'].addEventListener('click', () => send('newTab'));
  elements['load-more'].addEventListener('click', () => { elements['load-more'].disabled = true; send('loadMore'); });
  window.addEventListener('scroll', () => {
    clearTimeout(scrollTimer);
    scrollTimer = setTimeout(persist, 100);
  }, { passive: true });
  window.addEventListener('message', (event) => {
    if (event.data?.type !== 'state' || !event.data.state || typeof event.data.state !== 'object') return;
    state = event.data.state;
    resetPendingId = undefined;
    render();
    if (restoringScroll && !state.threads?.loading) {
      requestAnimationFrame(() => {
        window.scrollTo(0, Math.max(0, Number(saved.scrollTop) || 0));
        restoringScroll = false;
        persist();
      });
    }
  });
  const countdownTimer = setInterval(() => {
    if (new Date().toDateString() !== threadDay) renderThreads();
    updateCreditCount();
    document.querySelectorAll('[data-resets-at]').forEach((element) => {
      element.textContent = resetTime(Number(element.dataset.resetsAt));
    });
    document.querySelectorAll('.credit-card[data-expires-at]').forEach((card) => {
      if (Number(card.dataset.expiresAt) * 1000 > Date.now()) return;
      const badge = card.querySelector('.badge');
      badge.textContent = '已失效';
      badge.classList.remove('available');
      card.querySelector('.reset-credit').disabled = true;
      delete card.dataset.expiresAt;
    });
  }, 30000);
  window.addEventListener('pagehide', () => {
    persist();
    clearInterval(countdownTimer);
    clearTimeout(searchTimer);
    clearTimeout(scrollTimer);
  });
  send('ready');
  if (elements.search.value) send('search', { query: elements.search.value });
})();
