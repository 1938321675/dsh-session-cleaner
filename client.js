window.__ModuleLoader__.load({
  id: "dsh-session-cleaner",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    var React = require("react");
    const h = React.createElement;
    const useState = React.useState;
    const useEffect = React.useEffect;
    const useCallback = React.useCallback;

    const API = "/plugins/dsh-session-cleaner";

    async function api(path, options) {
      const init = Object.assign({ headers: { "content-type": "application/json" } }, options || {});
      const response = await fetch(API + path, init);
      let data = {};
      try { data = await response.json(); } catch (e) { data = {}; }
      if (!response.ok || data.ok === false) {
        throw new Error(data.error || ("HTTP " + response.status));
      }
      return data;
    }

    function formatTime(ms) {
      if (typeof ms !== "number" || !isFinite(ms)) return "-";
      const d = new Date(ms);
      const pad = (n) => String(n).padStart(2, "0");
      return d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate()) +
        " " + pad(d.getHours()) + ":" + pad(d.getMinutes());
    }

    function formatSize(bytes) {
      if (typeof bytes !== "number") return "-";
      if (bytes < 1024) return bytes + " B";
      if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + " KB";
      return (bytes / (1024 * 1024)).toFixed(1) + " MB";
    }

    const CATEGORY_LABEL = { main: "主会话", subagent: "子代理", automation: "定时任务", mnemon: "记忆任务" };

    const styles = {
      page: { padding: "4px 2px 16px", fontSize: 13, color: "inherit", lineHeight: 1.6 },
      header: { display: "flex", alignItems: "baseline", gap: 12, flexWrap: "wrap", marginBottom: 10 },
      title: { fontSize: 15, fontWeight: 600, margin: 0 },
      hint: { opacity: 0.65, fontSize: 12 },
      bar: { display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap", marginBottom: 10 },
      button: {
        border: "1px solid rgba(127,127,127,0.45)", background: "transparent", color: "inherit",
        borderRadius: 6, padding: "4px 12px", fontSize: 13, cursor: "pointer",
      },
      buttonDanger: {
        border: "1px solid rgba(200,60,60,0.55)", background: "transparent", color: "#c0392b",
        borderRadius: 6, padding: "4px 12px", fontSize: 13, cursor: "pointer",
      },
      table: { width: "100%", borderCollapse: "collapse", fontSize: 12.5 },
      th: { textAlign: "left", padding: "5px 8px", borderBottom: "1px solid rgba(127,127,127,0.35)", fontWeight: 600, whiteSpace: "nowrap" },
      td: { padding: "5px 8px", borderBottom: "1px solid rgba(127,127,127,0.18)", verticalAlign: "middle" },
      scroll: { maxHeight: 380, overflow: "auto", border: "1px solid rgba(127,127,127,0.25)", borderRadius: 8 },
      notice: { padding: "6px 10px", borderRadius: 6, marginBottom: 10, fontSize: 12.5 },
      noticeOk: { background: "rgba(46,160,67,0.12)", color: "inherit" },
      noticeError: { background: "rgba(200,60,60,0.14)", color: "#c0392b" },
      risk: { color: "#b8860b", fontSize: 12 },
      empty: { padding: "18px 12px", opacity: 0.6, textAlign: "center" },
      select: {
        border: "1px solid rgba(127,127,127,0.45)", background: "transparent", color: "inherit",
        borderRadius: 6, padding: "4px 8px", fontSize: 13,
      },
      sectionTitle: { fontSize: 13.5, fontWeight: 600, margin: "16px 0 8px" },
      batchRow: { display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap", padding: "6px 0", borderBottom: "1px solid rgba(127,127,127,0.15)" },
    };

    function SessionCleanerPage() {
      const [phase, setPhase] = useState("idle");
      const [error, setError] = useState(null);
      const [notice, setNotice] = useState(null);
      const [sessions, setSessions] = useState([]);
      const [workspaces, setWorkspaces] = useState([]);
      const [workspaceFilter, setWorkspaceFilter] = useState("");
      const [includeSystem, setIncludeSystem] = useState(false);
      const [includeRecent, setIncludeRecent] = useState(false);
      const [selected, setSelected] = useState({});
      const [batches, setBatches] = useState([]);

      const scan = useCallback(async (nextFilter, nextSystem) => {
        setPhase("scanning");
        setError(null);
        setNotice(null);
        try {
          const filter = typeof nextFilter === "string" ? nextFilter : workspaceFilter;
          const system = typeof nextSystem === "boolean" ? nextSystem : includeSystem;
          const query = API + "/scan?includeSystem=" + (system ? "1" : "0");
          const response = await fetch(query);
          const data = await response.json().catch(() => ({}));
          if (!response.ok || data.ok === false) throw new Error(data.error || ("HTTP " + response.status));
          setSessions(data.sessions || []);
          setWorkspaces(data.workspaces || []);
          setSelected({});
          setPhase("idle");
          return data;
        } catch (e) {
          setPhase("idle");
          setError(String(e && e.message ? e.message : e));
          return null;
        }
      }, [workspaceFilter, includeSystem]);

      const loadBatches = useCallback(async () => {
        try {
          const data = await api("/batches");
          setBatches(data.batches || []);
        } catch (e) {
          setError(String(e && e.message ? e.message : e));
        }
      }, []);

      useEffect(() => {
        scan("", false);
        loadBatches();
      }, []);

      const visible = sessions.filter((session) => {
        if (!workspaceFilter) return true;
        return session.workspace === workspaceFilter;
      });

      const selectedList = visible.filter((session) => selected[session.workspace + "/" + session.dir]);
      const selectedRecent = selectedList.some((session) => session.recent);
      const allSelected = visible.length > 0 && selectedList.length === visible.length;

      function toggleAll() {
        const next = {};
        if (!allSelected) {
          for (const session of visible) next[session.workspace + "/" + session.dir] = true;
        }
        setSelected(next);
      }

      function toggleOne(key) {
        setSelected((previous) => {
          const next = Object.assign({}, previous);
          if (next[key]) delete next[key];
          else next[key] = true;
          return next;
        });
      }

      async function quarantine() {
        if (selectedList.length === 0) return;
        setPhase("working");
        setError(null);
        setNotice(null);
        try {
          const data = await api("/quarantine", {
            method: "POST",
            body: JSON.stringify({
              targets: selectedList.map((session) => ({ workspace: session.workspace, dir: session.dir })),
              includeRecent: includeRecent,
            }),
          });
          setNotice("已移入隔离区批次 " + data.batch + "，移动 " + data.moved + " 个" +
            (data.rejected && data.rejected.length ? "，拒绝 " + data.rejected.length + " 个" : ""));
          await scan();
          await loadBatches();
        } catch (e) {
          setError(String(e && e.message ? e.message : e));
        } finally {
          setPhase("idle");
        }
      }

      async function restore(batch) {
        setPhase("working");
        setError(null);
        setNotice(null);
        try {
          const data = await api("/restore", { method: "POST", body: JSON.stringify({ batch: batch }) });
          setNotice("批次 " + batch + " 已恢复 " + data.restored + " 个" +
            (data.remaining > 0 ? "，剩余 " + data.remaining + " 个未能恢复" : ""));
          await loadBatches();
          await scan();
        } catch (e) {
          setError(String(e && e.message ? e.message : e));
        } finally {
          setPhase("idle");
        }
      }

      async function purge(batch) {
        if (!window.confirm("彻底删除批次 " + batch + "？此操作不可恢复。")) return;
        setPhase("working");
        setError(null);
        setNotice(null);
        try {
          await api("/purge", { method: "POST", body: JSON.stringify({ batch: batch }) });
          setNotice("批次 " + batch + " 已彻底删除");
          await loadBatches();
        } catch (e) {
          setError(String(e && e.message ? e.message : e));
        } finally {
          setPhase("idle");
        }
      }

      const busy = phase !== "idle";

      return h("div", { style: styles.page },
        h("div", { style: styles.header },
          h("h3", { style: styles.title }, "空会话清理"),
          h("span", { style: styles.hint }, "只处理没有任何对话内容的空白会话；删除会先移入隔离区。"),
        ),

        error ? h("div", { style: Object.assign({}, styles.notice, styles.noticeError) }, error) : null,
        notice ? h("div", { style: Object.assign({}, styles.notice, styles.noticeOk) }, notice) : null,

        h("div", { style: styles.bar },
          h("select", {
            style: styles.select, value: workspaceFilter, disabled: busy,
            onChange: (event) => setWorkspaceFilter(event.target.value),
          },
            h("option", { value: "" }, "全部工作区（" + workspaces.length + "）"),
            workspaces.map((workspace) =>
              h("option", { key: workspace.dir, value: workspace.dir },
                workspace.path + "（" + workspace.sessions + "）")),
          ),
          h("label", { style: { display: "flex", alignItems: "center", gap: 6, fontSize: 12.5, opacity: 0.85 } },
            h("input", {
              type: "checkbox", checked: includeSystem, disabled: busy,
              onChange: (event) => {
                setIncludeSystem(event.target.checked);
                scan(workspaceFilter, event.target.checked);
              },
            }),
            "包含子代理 / 定时任务 / 记忆会话",
          ),
          h("button", {
            style: Object.assign({}, styles.button, busy ? { opacity: 0.5, cursor: "default" } : {}),
            onClick: () => scan(workspaceFilter, includeSystem), disabled: busy,
          }, phase === "scanning" ? "扫描中…" : "扫描"),
          h("span", { style: styles.hint },
            "共 " + visible.length + " 个空白会话" + (selectedList.length ? "，已选 " + selectedList.length + " 个" : "")),
        ),

        visible.length === 0
          ? h("div", { style: styles.empty }, busy ? "处理中…" : "没有发现空白会话")
          : h("div", { style: styles.scroll },
            h("table", { style: styles.table },
              h("thead", null,
                h("tr", null,
                  h("th", { style: styles.th },
                    h("input", { type: "checkbox", checked: allSelected, onChange: toggleAll, disabled: busy, title: "全选" })),
                  h("th", { style: styles.th }, "工作区"),
                  h("th", { style: styles.th }, "会话"),
                  h("th", { style: styles.th }, "创建时间"),
                  h("th", { style: styles.th }, "大小"),
                  h("th", { style: styles.th }, "类型"),
                  h("th", { style: styles.th }, "备注"),
                ),
              ),
              h("tbody", null,
                visible.map((session) => {
                  const key = session.workspace + "/" + session.dir;
                  return h("tr", { key: key },
                    h("td", { style: styles.td },
                      h("input", {
                        type: "checkbox", checked: !!selected[key], disabled: busy,
                        onChange: () => toggleOne(key),
                      }),
                    ),
                    h("td", { style: styles.td, title: session.workspace }, session.workspacePath),
                    h("td", { style: styles.td, title: session.id }, session.dir),
                    h("td", { style: styles.td }, formatTime(session.createdAt)),
                    h("td", { style: styles.td }, formatSize(session.bytes)),
                    h("td", { style: styles.td }, CATEGORY_LABEL[session.category] || session.category),
                    h("td", { style: styles.td },
                      session.recent ? h("span", { style: styles.risk }, "刚创建，可能正在用") : ""),
                  );
                }),
              ),
            ),
          ),

        h("div", { style: styles.bar },
          h("label", { style: { display: "flex", alignItems: "center", gap: 6, fontSize: 12.5 } },
            h("input", {
              type: "checkbox", checked: includeRecent, disabled: busy,
              onChange: (event) => setIncludeRecent(event.target.checked),
            }),
            "包含创建不足 10 分钟的会话（风险项）",
          ),
          h("button", {
            style: Object.assign({}, styles.buttonDanger, (busy || selectedList.length === 0) ? { opacity: 0.5, cursor: "default" } : {}),
            disabled: busy || selectedList.length === 0 || (selectedRecent && !includeRecent),
            onClick: quarantine,
          }, "移入隔离区（" + selectedList.length + "）"),
          selectedRecent && !includeRecent
            ? h("span", { style: styles.risk }, "所选包含风险项，需勾选上方确认")
            : null,
        ),

        h("div", { style: styles.sectionTitle }, "隔离区批次"),
        batches.length === 0
          ? h("div", { style: { opacity: 0.6, fontSize: 12.5, padding: "4px 0" } }, "暂无隔离批次")
          : h("div", null,
            batches.map((item) =>
              h("div", { key: item.batch, style: styles.batchRow },
                h("span", { style: { fontFamily: "ui-monospace, monospace", fontSize: 12.5 } }, item.batch),
                h("span", { style: styles.hint },
                  (item.manifest && item.manifest.entries ? item.manifest.entries.length : 0) + " 个会话" +
                  (item.manifest && item.manifest.createdAt ? "，创建于 " + formatTime(item.manifest.createdAt) : "")),
                h("button", {
                  style: Object.assign({}, styles.button, busy ? { opacity: 0.5, cursor: "default" } : {}),
                  disabled: busy, onClick: () => restore(item.batch),
                }, "恢复"),
                h("button", {
                  style: Object.assign({}, styles.buttonDanger, busy ? { opacity: 0.5, cursor: "default" } : {}),
                  disabled: busy, onClick: () => purge(item.batch),
                }, "彻底删除"),
              ),
            ),
          ),

        h("div", { style: Object.assign({}, styles.hint, { marginTop: 14 }) },
          "说明：空白会话指日志里只有会话头与初始化事件、从未产生任何消息或工具调用的会话。" +
          "隔离区位于 ~/.dsh/sessions-quarantine/session-cleaner/，可随时恢复；只有点「彻底删除」才会真的移除文件。"),
      );
    }

    exports.apply = function apply(ctx) {
      ctx.slots.inject("settings.section", function () {
        return ctx.slots.register(
          {
            name: "settings.section",
            id: "session-cleaner",
            order: 200,
            label: "空会话清理",
          },
          SessionCleanerPage,
        );
      });
    };

    exports.inject = ["slots"];

    return module.exports;
  },
});
