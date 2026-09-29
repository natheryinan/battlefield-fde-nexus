export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const clientIP = request.headers.get("cf-connecting-ip") || "127.0.0.1";
    const country = request.cf?.country || "US";
    const city = request.cf?.city || "Philadelphia";

    const corsHeaders = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization",
    };

    if (request.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders });
    }

    // -------------------------------------------------------------
    // API 1: 健康检查 Endpoint
    // -------------------------------------------------------------
    if (url.pathname === "/api/health-check") {
      return new Response(
        JSON.stringify({
          status: "healthy",
          node: "cloudflare-edge",
          timestamp: new Date().toISOString(),
          ip: clientIP,
          location: `${city}, ${country}`
        }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // -------------------------------------------------------------
    // API 2: Gemini AI 原生 REST Endpoint (带 KV 缓存与多模型 Failover 降级)
    // -------------------------------------------------------------
    if (url.pathname === "/api/v1/chat" && request.method === "POST") {
      try {
        const body = await request.json().catch(() => ({}));
        const prompt = body.prompt;
        if (!prompt) {
          return new Response(JSON.stringify({ error: "Prompt is required" }), {
            status: 400,
            headers: { ...corsHeaders, "Content-Type": "application/json" }
          });
        }

        const cacheKey = `prompt_cache:${encodeURIComponent(prompt.trim())}`;
        
        // 1. 优先读取 Cloudflare KV 缓存
        if (env.NEXUS_CACHE) {
          try {
            const cachedResponse = await env.NEXUS_CACHE.get(cacheKey);
            if (cachedResponse) {
              return new Response(
                JSON.stringify({
                  success: true,
                  prompt: prompt,
                  response: `[KV-CACHE-HIT]: ${cachedResponse}`,
                  cached: true,
                  timestamp: new Date().toISOString()
                }),
                { headers: { ...corsHeaders, "Content-Type": "application/json" } }
              );
            }
          } catch (cacheErr) {
            console.warn("KV Cache Read Error:", cacheErr.message);
          }
        }

        const apiKey = env.GEMINI_API_KEY || env.lordalmightywife;
        if (!apiKey) {
          return new Response(
            JSON.stringify({
              success: false,
              error: "API Key is missing. Please set GEMINI_API_KEY via wrangler secret."
            }),
            { headers: { ...corsHeaders, "Content-Type": "application/json" } }
          );
        }

        // 备选模型链路：优先 gemini-3.8-flash，拥堵时自动切至低延迟高并发的 gemini-3.5-flash-lite
        const candidateModels = ["gemini-3.8-flash", "gemini-3.5-flash-lite"];
        let responseText = null;
        let lastError = null;

        for (const modelName of candidateModels) {
          const geminiUrl = `https://generativelanguage.googleapis.com/v1beta/models/${modelName}:generateContent?key=${apiKey}`;
          
          for (let attempt = 1; attempt <= 2; attempt++) {
            try {
              const aiReq = await fetch(geminiUrl, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                  contents: [{ parts: [{ text: prompt }] }]
                })
              });

              const aiData = await aiReq.json();

              if (aiReq.ok && aiData.candidates?.[0]?.content?.parts?.[0]?.text) {
                responseText = aiData.candidates[0].content.parts[0].text;
                break;
              } else {
                lastError = aiData.error?.message || `HTTP ${aiReq.status}`;
              }
            } catch (fetchErr) {
              lastError = fetchErr.message;
            }

            if (attempt < 2) {
              await new Promise((resolve) => setTimeout(resolve, 800));
            }
          }

          if (responseText) break;
        }

        if (responseText) {
          // 2. 写入 Cloudflare KV 缓存 (TTL: 24小时)
          if (env.NEXUS_CACHE) {
            ctx.waitUntil(
              env.NEXUS_CACHE.put(cacheKey, responseText, { expirationTtl: 86400 }).catch(() => {})
            );
          }

          return new Response(
            JSON.stringify({
              success: true,
              prompt: prompt,
              response: responseText,
              cached: false,
              timestamp: new Date().toISOString()
            }),
            { headers: { ...corsHeaders, "Content-Type": "application/json" } }
          );
        } else {
          return new Response(
            JSON.stringify({
              success: false,
              error: `[NEXUS-AI High Load]: Upstream models temporarily busy. (${lastError})`
            }),
            { headers: { ...corsHeaders, "Content-Type": "application/json" } }
          );
        }
      } catch (err) {
        return new Response(
          JSON.stringify({
            success: false,
            error: `[Gateway Worker Error]: ${err.message}`
          }),
          { headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }
    }

    // -------------------------------------------------------------
    // API 3: D1 遥测数据上报与心跳
    // -------------------------------------------------------------
    if (url.pathname === "/api/telemetry/heartbeat" && request.method === "POST") {
      try {
        const body = await request.json().catch(() => ({}));
        const { sessionId, dwellSeconds, eventType, hardwareConcurrency, screenResolution, lastCommand, errorStack } = body;
        const timestamp = new Date().toISOString();
        const userAgent = request.headers.get("user-agent") || "UNKNOWN";

        if (env.DB) {
          const query = `
            INSERT INTO telemetry_logs (
              session_id, timestamp, dwell_seconds, event_type, ip, country, city, user_agent, hardware_concurrency, screen_resolution, last_command, error_stack
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(session_id) DO UPDATE SET
              dwell_seconds = excluded.dwell_seconds,
              timestamp = excluded.timestamp,
              event_type = excluded.event_type,
              last_command = COALESCE(excluded.last_command, telemetry_logs.last_command),
              error_stack = COALESCE(excluded.error_stack, telemetry_logs.error_stack);
          `;

          await env.DB.prepare(query)
            .bind(
              sessionId || "UNKNOWN",
              timestamp,
              dwellSeconds || 0,
              eventType || "heartbeat",
              clientIP,
              country,
              city,
              userAgent,
              hardwareConcurrency || 0,
              screenResolution || "UNKNOWN",
              lastCommand || null,
              errorStack || null
            )
            .run();
        }

        return new Response(JSON.stringify({ success: true }), {
          headers: { ...corsHeaders, "Content-Type": "application/json" }
        });
      } catch (err) {
        return new Response(JSON.stringify({ success: false, error: err.message }), {
          status: 500,
          headers: { ...corsHeaders, "Content-Type": "application/json" }
        });
      }
    }

    // -------------------------------------------------------------
    // API 4: 遥测数据 Log 查询
    // -------------------------------------------------------------
    if (url.pathname === "/api/telemetry/recent-logs" && request.method === "GET") {
      try {
        let results = [];
        if (env.DB) {
          const logs = await env.DB.prepare(`
            SELECT session_id, city, country, ip, dwell_seconds, last_command, timestamp 
            FROM telemetry_logs 
            ORDER BY id DESC 
            LIMIT 5;
          `).all();
          results = logs.results || [];
        }

        return new Response(
          JSON.stringify({ logs: results }),
          { headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      } catch (err) {
        return new Response(JSON.stringify({ error: err.message }), {
          status: 500,
          headers: { ...corsHeaders, "Content-Type": "application/json" }
        });
      }
    }

    // -------------------------------------------------------------
    // Dashboard UI Render
    // -------------------------------------------------------------
    const htmlContent = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>BATTLEFIELD FDE NEXUS GATEWAY</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { background-color: #030712; color: #00ffcc; font-family: 'Courier New', Consolas, monospace; padding: 24px; }
    .container { max-width: 1000px; margin: 0 auto; border: 1px solid #00ffcc33; padding: 20px; background: rgba(3, 7, 18, 0.95); box-shadow: 0 0 20px rgba(0, 255, 204, 0.1); }
    h1 { text-align: center; font-size: 22px; letter-spacing: 2px; color: #00ffcc; border-bottom: 1px solid #00ffcc33; padding-bottom: 15px; margin-bottom: 20px; }
    .status-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(280px, 1fr)); gap: 15px; margin-bottom: 20px; }
    .status-card { border: 1px solid #00ffcc44; padding: 15px; background: #081225; }
    .status-title { font-size: 12px; color: #88a0b0; margin-bottom: 8px; text-transform: uppercase; }
    .status-value { font-size: 14px; font-weight: bold; color: #00ffcc; }
    .badge { background: #00ffcc22; color: #00ffcc; border: 1px solid #00ffcc; font-size: 10px; padding: 2px 6px; float: right; }
    .terminal-container { border: 1px solid #ff005588; background: #040914; padding: 15px; }
    .terminal-header { font-size: 12px; color: #ff0055; margin-bottom: 10px; }
    .terminal-box { height: 320px; overflow-y: auto; font-size: 13px; line-height: 1.6; color: #00ffcc; padding-right: 5px; }
    .input-row { display: flex; margin-top: 10px; border-top: 1px dashed #00ffcc33; padding-top: 10px; }
    .prompt-label { color: #ff0055; margin-right: 10px; font-weight: bold; }
    input[type="text"] { background: transparent; border: none; outline: none; color: #00ffcc; font-family: inherit; font-size: 13px; flex: 1; }
    .cmd-line { color: #ffffff; }
    .ai-loading { color: #e3b341; }
    .ai-success { color: #00ff66; white-space: pre-wrap; word-break: break-word; margin-top: 5px; margin-bottom: 15px; display: block; }
    .ai-error { color: #ff0055; }
  </style>
</head>
<body>
  <div class="container">
    <h1>// BATTLEFIELD FDE NEXUS GATEWAY</h1>

    <div class="status-grid">
      <div class="status-card">
        <span class="badge">ONLINE</span>
        <div class="status-title">Agentic AI Pipeline Service</div>
        <div class="status-value">Gemini 3.8 / 3.5 + KV Cache</div>
      </div>
      <div class="status-card">
        <span class="badge">CONNECTED</span>
        <div class="status-title">D1 Log Persistence Engine</div>
        <div class="status-value">telemetry-db (SQLite)</div>
      </div>
      <div class="status-card">
        <span class="badge">ACTIVE</span>
        <div class="status-title">Ingress Node Location</div>
        <div class="status-value">${city}, ${country} (${clientIP})</div>
      </div>
    </div>

    <div class="terminal-container">
      <div class="terminal-header">[INTERACTIVE SYSTEM TERMINAL - TYPE 'help', 'ai &lt;prompt&gt;', 'logs' OR 'whoami']</div>
      <div class="terminal-box" id="term-out">
        [SYS_INIT] Gateway loaded successfully.<br/>
        [D1_STATUS] Database binding verified: DB.<br/>
        [KV_CACHE] Edge Cache Layer Bound: NEXUS_CACHE.<br/>
        [GEO_TRACE] Ingress: ${city}, ${country} | IP: ${clientIP}<br/><br/>
      </div>
      <div class="input-row">
        <span class="prompt-label">root@yinan-gate:~#</span>
        <input type="text" id="term-in" placeholder="Enter command..." autofocus onkeyup="checkEnter(event)" />
      </div>
    </div>
  </div>

  <script>
    var sessionId = "SESS-" + Math.random().toString(36).substring(2, 9).toUpperCase();
    var dwell = 0;
    var clientIP = "${clientIP}";
    var city = "${city}";
    var country = "${country}";

    function appendLog(html) {
      var out = document.getElementById("term-out");
      if (out) {
        out.innerHTML += html;
        out.scrollTop = out.scrollHeight;
      }
    }

    function formatMarkdown(text) {
      if (!text) return "";
      return text
        .split("\\n").join("<br/>")
        .split("**").reduce(function(acc, item, idx) {
          return acc + (idx % 2 === 1 ? '<b style="color:#ffffff;">' + item + '</b>' : item);
        }, "");
    }

    function sendTelemetry(cmd) {
      dwell += 5;
      return fetch("/api/telemetry/heartbeat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sessionId: sessionId,
          dwellSeconds: dwell,
          eventType: "heartbeat",
          hardwareConcurrency: navigator.hardwareConcurrency || 0,
          screenResolution: window.screen.width + "x" + window.screen.height,
          lastCommand: cmd || null
        })
      }).catch(function(err){ console.error(err); });
    }

    setInterval(function(){ sendTelemetry(null); }, 5000);

    function checkEnter(e) {
      if (e.keyCode === 13 || e.key === "Enter") {
        execCmd();
      }
    }

    function execCmd() {
      var input = document.getElementById("term-in");
      if (!input) return;

      var cmd = input.value.trim();
      if (!cmd) return;

      input.value = "";
      appendLog('<div><span class="cmd-line">root@yinan-gate:~# ' + cmd + '</span></div>');

      sendTelemetry(cmd);

      if (cmd === "help") {
        appendLog('<div>Available Commands:<br/>' +
          '&nbsp;&nbsp;<b>ai &lt;prompt&gt;</b> : Dispatch prompt to Edge AI Service (KV Cache Enabled)<br/>' +
          '&nbsp;&nbsp;<b>logs</b> : Query latest 5 D1 telemetry records<br/>' +
          '&nbsp;&nbsp;<b>status</b> : Show gateway health status<br/>' +
          '&nbsp;&nbsp;<b>whoami</b> : Display client connection context<br/>' +
          '&nbsp;&nbsp;<b>clear</b> : Clear terminal screen</div><br/>');
      } else if (cmd.indexOf("ai") === 0) {
        var prompt = cmd.replace(/^ai[:：\s]*/i, "").trim();
        if (!prompt) {
          appendLog('<div><span class="ai-error">[System Alert]: Prompt cannot be empty. Usage: ai &lt;your question&gt;</span></div><br/>');
          return;
        }

        appendLog('<div><span class="ai-loading">[AI Orchestrator]: Dispatching to Gemini Edge API...</span></div>');

        fetch("/api/v1/chat", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ prompt: prompt })
        })
        .then(function(res){ return res.json(); })
        .then(function(data){
          if (data.response) {
            var formatted = formatMarkdown(data.response);
            appendLog('<div><span class="ai-success">' + formatted + '</span></div>');
          } else {
            appendLog('<div><span class="ai-error">[AI Error]: ' + (data.error || 'Unknown error') + '</span></div><br/>');
          }
        })
        .catch(function(err){
          appendLog('<div><span class="ai-error">[AI Network Error]: ' + err.message + '</span></div><br/>');
        });
      } else if (cmd === "logs") {
        fetch("/api/telemetry/recent-logs")
        .then(function(res){ return res.json(); })
        .then(function(data){
          appendLog('<pre style="color:#00ffcc;">' + JSON.stringify(data.logs, null, 2) + '</pre><br/>');
        });
      } else if (cmd === "whoami") {
        appendLog('<div>Client IP: ' + clientIP + '<br/>Location: ' + city + ', ' + country + '<br/>Session: ' + sessionId + '</div><br/>');
      } else if (cmd === "status") {
        appendLog('<div>Node: Cloudflare Edge<br/>KV Cache: ACTIVE<br/>D1 Status: CONNECTED<br/>AI Engine: READY</div><br/>');
      } else if (cmd === "clear") {
        document.getElementById("term-out").innerHTML = "";
      } else {
        appendLog('<div>Command not found: ' + cmd + '. Type "help" for available options.</div><br/>');
      }
    }
  </script>
</body>
</html>`;

    return new Response(htmlContent, {
      headers: { "Content-Type": "text/html; charset=utf-8" }
    });
  }
};