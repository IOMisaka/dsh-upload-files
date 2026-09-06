/**
 * dsh-upload-files — client half.
 *
 * Hand-written bundle in the exact wire format the DSH web shell expects:
 * a CJS factory handed to window.__ModuleLoader__.load({ id, factory }),
 * with platform modules (react, react-dom/client, primitives) resolved
 * through the injected require seed table.
 *
 * Placement: an upload icon button in the workspace section header row —
 * next to the search / view-options / add-workspace icons. That row is
 * hardcoded JSX inside @deepseek-ai/dsh-client-ui-workspace (no slot), so
 * this bundle injects a container div into the sectionHeader element and
 * renders the button through its own React root, using the shell's
 * primitives Tooltip for an identical hover label. A MutationObserver
 * re-attaches the container whenever React reconciliation removes it.
 *
 * Interaction:
 *   - click      → native multi-file picker; selected files are base64-encoded
 *                 and POSTed to /upload-files as one batch; icon shows
 *                 uploading/done/error state with a hover detail tooltip.
 *   - right-click→ history panel (fixed overlay): recent upload entries from
 *                 GET /uploads/history, each file row copies its absolute path;
 *                 the panel reminds that agents query these files via the
 *                 list_uploads tool.
 */
window.__ModuleLoader__.load({
  id: 'dsh-upload-files',
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    var React = require('react');
    var ReactDOMClient = require('react-dom/client');
    var Primitives = require('@deepseek-ai/dsh-client-ui-primitives');
    var Tooltip = Primitives.Tooltip;
    var inject = ['slots'];

    var MAX_FILE_BYTES = 50 * 1024 * 1024;
    var MAX_BATCH_BYTES = 200 * 1024 * 1024;
    var MAX_FILES = 100;

    function fileToBase64(file) {
      return new Promise(function (resolve, reject) {
        var reader = new FileReader();
        reader.onload = function () {
          var bytes = new Uint8Array(reader.result);
          var binary = '';
          var CHUNK = 0x8000;
          for (var i = 0; i < bytes.length; i += CHUNK) {
            binary += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
          }
          resolve(btoa(binary));
        };
        reader.onerror = function () { reject(reader.error || new Error('read failed')); };
        reader.readAsArrayBuffer(file);
      });
    }

    function formatBytes(n) {
      if (n < 1024) return n + ' B';
      if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KiB';
      if (n < 1024 * 1024 * 1024) return (n / 1024 / 1024).toFixed(1) + ' MiB';
      return (n / 1024 / 1024 / 1024).toFixed(2) + ' GiB';
    }

    function copyText(text) {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        return navigator.clipboard.writeText(text);
      }
      return Promise.reject(new Error('clipboard unavailable'));
    }

    // ── icon button rendered into the injected header container ──
    function UploadIconButton() {
      var phaseState = React.useState('idle');
      var phase = phaseState[0];
      var setPhase = phaseState[1];
      var messageState = React.useState('');
      var message = messageState[0];
      var setMessage = messageState[1];
      var detailState = React.useState([]);
      var detail = detailState[0];
      var setDetail = detailState[1];
      var panelOpenState = React.useState(false);
      var panelOpen = panelOpenState[0];
      var setPanelOpen = panelOpenState[1];
      var historyState = React.useState(null);
      var historyData = historyState[0];
      var setHistoryData = historyState[1];
      var anchorState = React.useState({ left: 8, top: 64 });
      var anchor = anchorState[0];
      var setAnchor = anchorState[1];
      var copiedState = React.useState('');
      var copiedKey = copiedState[0];
      var setCopiedKey = copiedState[1];
      var openDirPhaseState = React.useState('idle'); // idle | busy | opened | error
      var openDirPhase = openDirPhaseState[0];
      var setOpenDirPhase = openDirPhaseState[1];

      var btnRef = React.useRef(null);
      var inputRef = React.useRef(null);

      // Hidden multi-file picker, owned for the component lifetime.
      React.useEffect(function () {
        if (typeof document === 'undefined') return;
        var el = document.createElement('input');
        el.type = 'file';
        el.multiple = true;
        el.style.display = 'none';
        el.addEventListener('change', function () {
          handleFiles(el.files);
          el.value = '';
        });
        document.body.appendChild(el);
        inputRef.current = el;
        return function () { el.remove(); };
      }, []);

      var handleFiles = function (fileList) {
        var files = Array.prototype.slice.call(fileList || []);
        if (!files.length) return;
        for (var i = 0; i < files.length; i++) {
          if (files[i].size > MAX_FILE_BYTES) {
            setPhase('error');
            setMessage(files[i].name + ' 超过单文件 50 MiB 限制');
            setDetail([]);
            return;
          }
        }
        var total = files.reduce(function (sum, f) { return sum + f.size; }, 0);
        if (files.length > MAX_FILES || total > MAX_BATCH_BYTES) {
          setPhase('error');
          setMessage('超出批量限制（≤' + MAX_FILES + ' 个文件 / ≤200 MiB）');
          setDetail([]);
          return;
        }
        setPhase('busy');
        setMessage('上传中…');
        setDetail([]);
        Promise.all(files.map(fileToBase64))
          .then(function (datas) {
            var payload = files.map(function (f, i) {
              return { name: f.name, mime: f.type || '', size: f.size, dataBase64: datas[i] };
            });
            return fetch('/upload-files', {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ files: payload })
            });
          })
          .then(function (res) { return res.json().catch(function () { return null; }); })
          .then(function (data) {
            if (!data || !data.ok) {
              setPhase('error');
              setMessage(String((data && data.message) || '上传失败'));
              return;
            }
            var lines = [];
            for (var i = 0; i < data.files.length; i++) {
              lines.push(data.files[i].name + ' → ' + data.files[i].path);
            }
            setPhase('done');
            setMessage('已上传 ' + String(data.files.length) + ' 个文件');
            setDetail(lines);
          })
          .catch(function (err) {
            setPhase('error');
            setMessage(String((err && err.message) || err));
          });
      };

      var openPicker = function () {
        if (phase === 'busy') return;
        if (inputRef.current) inputRef.current.click();
      };

      var openPanel = function (event) {
        event.preventDefault();
        if (!panelOpen && btnRef.current) {
          var rect = btnRef.current.getBoundingClientRect();
          setAnchor({ left: Math.min(rect.right + 8, window.innerWidth - 360), top: Math.max(12, rect.top) });
          fetch('/uploads/history?limit=50')
            .then(function (res) { return res.json().catch(function () { return null; }); })
            .then(function (data) { setHistoryData(data && data.ok ? data : null); });
        }
        setPanelOpen(true);
      };

      var closePanel = function () { setPanelOpen(false); };

      var copyPath = function (key, path) {
        copyText(path).then(function () {
          setCopiedKey(key);
          window.setTimeout(function () { setCopiedKey(''); }, 1500);
        }).catch(function () {});
      };

      var openDirectory = function () {
        if (openDirPhase === 'busy') return;
        setOpenDirPhase('busy');
        fetch('/uploads/open-dir', { method: 'POST' })
          .then(function (res) { return res.json().catch(function () { return null; }); })
          .then(function (data) {
            if (!data || !data.ok) throw new Error(String((data && data.message) || '打开目录失败'));
            setOpenDirPhase('opened');
            window.setTimeout(function () { setOpenDirPhase('idle'); }, 2000);
          })
          .catch(function (err) {
            console.error('[dsh-upload-files] open-dir failed:', err && err.message ? err.message : err);
            setOpenDirPhase('error');
            window.setTimeout(function () { setOpenDirPhase('idle'); }, 2500);
          });
      };

      var title = (phase === 'done' || phase === 'error') && detail.length > 0
        ? message + '\n\n' + detail.join('\n')
        : phase === 'busy'
          ? '正在上传…'
          : '点击选择文件上传（可多选）；右键查看上传历史';

      var cls = 'dsu-icon'
        + (phase === 'busy' || phase === 'done' ? ' dsu-icon--armed' : '')
        + (phase === 'error' ? ' dsu-icon--error' : '');

      var panel = null;
      if (panelOpen) {
        var entries = historyData && Array.isArray(historyData.entries) ? historyData.entries : [];
        panel = [
          React.createElement('div', { key: 'backdrop', className: 'dsu-panel-backdrop', onClick: closePanel }),
          React.createElement('div', {
            key: 'panel',
            className: 'dsu-panel',
            style: { left: anchor.left, top: anchor.top }
          }, [
            React.createElement('div', { className: 'dsu-panel__head' }, [
              React.createElement('span', null, '上传历史'),
              React.createElement('button', { type: 'button', className: 'dsu-panel__close', onClick: closePanel, 'aria-label': '关闭' }, '×')
            ]),
            historyData && React.createElement('div', { className: 'dsu-panel__dir' }, [
              React.createElement('span', { className: 'dsu-panel__path', title: historyData.directory }, historyData.directory),
              React.createElement('button', {
                type: 'button',
                className: 'dsu-panel__copy',
                onClick: function () { copyPath('__dir__', historyData.directory); }
              }, copiedKey === '__dir__' ? '已复制' : '复制'),
              React.createElement('button', {
                type: 'button',
                className: 'dsu-panel__open',
                title: '在文件管理器中打开该目录',
                onClick: openDirectory,
                disabled: openDirPhase === 'busy'
              }, openDirPhase === 'busy' ? '正在打开…' : openDirPhase === 'opened' ? '已打开 ✓' : openDirPhase === 'error' ? '打开失败' : '打开目录')
            ]),
            React.createElement('div', { className: 'dsu-panel__hint' }, 'agent 可通过 list_uploads 工具查询这些文件，按你的指令处理。'),
            React.createElement('div', { className: 'dsu-panel__list' }, entries.length === 0
              ? [React.createElement('div', { key: 'empty', className: 'dsu-panel__empty' }, '暂无上传记录')]
              : entries.map(function (entry) {
                  return React.createElement('div', { key: entry.id, className: 'dsu-entry' }, [
                    React.createElement('div', { className: 'dsu-entry__time' }, new Date(entry.uploadedAt).toLocaleString()),
                    (Array.isArray(entry.files) ? entry.files : []).map(function (file) {
                      var key = entry.id + ':' + file.name;
                      return React.createElement('button', {
                        type: 'button',
                        className: 'dsu-file',
                        title: '点击复制路径：' + file.path,
                        onClick: function () { copyPath(key, file.path); }
                      }, [
                        React.createElement('span', { className: 'dsu-file__name' }, file.name),
                        React.createElement('span', { className: 'dsu-file__size' }, formatBytes(file.size)),
                        copiedKey === key ? React.createElement('span', { className: 'dsu-file__copied' }, '已复制') : null
                      ]);
                    })
                  ]);
                }))
          ])
        ];
      }

      return React.createElement(React.Fragment, null, [
        React.createElement(Tooltip, { label: title, side: 'bottom', delayMs: 500 },
          React.createElement('button', {
            ref: btnRef,
            type: 'button',
            className: cls,
            onClick: openPicker,
            onContextMenu: openPanel,
            'aria-label': '上传文件',
            disabled: phase === 'busy'
          }, [
            React.createElement('svg', {
              width: 16, height: 16, viewBox: '0 0 24 24', fill: 'none',
              stroke: 'currentColor', strokeWidth: 2, strokeLinecap: 'round', strokeLinejoin: 'round'
            }, [
              React.createElement('path', { d: 'M12 16V4' }),
              React.createElement('path', { d: 'm7 9 5-5 5 5' }),
              React.createElement('path', { d: 'M4 20h16' })
            ])
          ])
        ),
        panel
      ]);
    }

    function apply(ctx) {
      // ── stylesheet (package-owned, cleaned up on teardown) ──
      ctx.effect(function () {
        if (typeof document === 'undefined') return function () {};
        var existing = document.querySelector('style[data-dsh-upload-files-css]');
        if (existing !== null) return function () {};
        var tag = document.createElement('style');
        tag.dataset.dshUploadFilesCss = '1';
        tag.textContent = [
          '.dsu-icon{cursor:pointer;width:20px;height:20px;color:var(--dsw-alias-label-tertiary);background:transparent;border:none;border-radius:4px;flex:none;justify-content:center;align-items:center;padding:0;display:inline-flex}',
          '.dsu-icon:hover{color:var(--dsw-alias-label-primary)}',
          '.dsu-icon--armed{color:var(--dsw-alias-state-success-primary)}',
          '.dsu-icon--error{color:var(--dsw-alias-state-error-primary)}',
          '.dsu-panel-backdrop{position:fixed;inset:0;z-index:9998;background:transparent}',
          '.dsu-panel{position:fixed;z-index:9999;width:340px;max-height:70vh;display:flex;flex-direction:column;background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l2);border-radius:12px;box-shadow:0 8px 24px rgba(0,0,0,.25);font-family:inherit;font-size:13px;color:var(--dsw-alias-label-primary)}',
          '.dsu-panel__head{display:flex;align-items:center;justify-content:space-between;padding:10px 12px;border-bottom:1px solid var(--dsw-alias-border-l2)}',
          '.dsu-panel__close{background:none;border:none;color:var(--dsw-alias-label-secondary);font-size:16px;line-height:1;cursor:pointer;padding:0 2px}',
          '.dsu-panel__dir{display:flex;align-items:center;gap:8px;padding:8px 12px;border-bottom:1px solid var(--dsw-alias-border-l2)}',
          '.dsu-panel__path{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--dsw-alias-label-secondary);font-size:12px}',
          '.dsu-panel__copy,.dsu-file__copied{background:none;border:none;color:var(--dsw-alias-state-success-primary);cursor:pointer;font-size:12px;padding:0}',
          '.dsu-panel__open{background:none;border:none;color:var(--dsw-alias-label-primary);cursor:pointer;font-size:12px;padding:0;text-decoration:underline;text-underline-offset:2px}',
          '.dsu-panel__open:disabled{opacity:.6;cursor:default}',
          '.dsu-panel__hint{padding:8px 12px;color:var(--dsw-alias-label-caption);font-size:12px;line-height:16px;border-bottom:1px solid var(--dsw-alias-border-l2)}',
          '.dsu-panel__list{overflow-y:auto;padding:4px 0}',
          '.dsu-panel__empty{padding:16px 12px;color:var(--dsw-alias-label-secondary);font-size:12px;text-align:center}',
          '.dsu-entry{padding:4px 12px}',
          '.dsu-entry__time{color:var(--dsw-alias-label-caption);font-size:11px;line-height:16px;margin-bottom:2px}',
          '.dsu-file{display:flex;align-items:center;gap:8px;width:100%;background:none;border:none;color:inherit;font-family:inherit;font-size:12px;text-align:left;cursor:pointer;padding:3px 4px;border-radius:6px}',
          '.dsu-file:hover{background:var(--dsw-alias-bg-layer-2)}',
          '.dsu-file__name{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}'
        ].join('\n');
        document.head.appendChild(tag);
        return function () { tag.remove(); };
      }, 'dsh-upload-files: stylesheet');

      // ── inject the icon into the workspace section header row ──
      ctx.effect(function () {
        if (typeof document === 'undefined') return function () {};
        var container = null;
        var root = null;
        var observer = null;
        var retryTimer = null;
        var disposed = false;

        // The workspace browser's section header: the row holding the search,
        // view-options and add-workspace icons. Matched by CSS-module local
        // names (hash prefix changes on rebuilds), disambiguated by requiring
        // a _headerActions child so other packages' "sectionHeader" classes
        // never match.
        function findHost() {
          var secs = document.querySelectorAll('[class*="_sectionHeader"]');
          for (var i = 0; i < secs.length; i++) {
            if (secs[i].querySelector('[class*="_headerActions"]')) return secs[i];
          }
          return null;
        }

        function ensureInjected() {
          if (disposed) return;
          retryTimer = null;
          if (container !== null && container.isConnected) return;
          var host = findHost();
          if (host === null) { scheduleRetry(); return; }
          if (container === null || root === null) {
            container = document.createElement('div');
            root = ReactDOMClient.createRoot(container);
            root.render(React.createElement(UploadIconButton));
          }
          host.appendChild(container);
        }

        function scheduleRetry() {
          if (disposed || retryTimer !== null) return;
          retryTimer = window.setTimeout(function () { ensureInjected(); }, 600);
        }

        ensureInjected();
        observer = new MutationObserver(function () { ensureInjected(); });
        observer.observe(document.body, { childList: true, subtree: true });

        return function () {
          disposed = true;
          if (retryTimer !== null) window.clearTimeout(retryTimer);
          if (observer) observer.disconnect();
          if (root) { try { root.unmount(); } catch (e) {} }
          if (container && container.isConnected) container.remove();
        };
      }, 'dsh-upload-files: workspace header icon');
    }

    module.exports = { apply: apply, inject: inject };
    return module.exports;
  }
});
