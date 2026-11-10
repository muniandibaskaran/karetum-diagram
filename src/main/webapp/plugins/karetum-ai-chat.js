(function() {
    function initPlugin() {
        if (typeof Draw === 'undefined' || typeof Draw.loadPlugin !== 'function') {
            setTimeout(initPlugin, 200);
            return;
        }

        Draw.loadPlugin(function(ui) {
            var graph = ui.editor.graph;
            var editor = ui.editor;

            var CONFIG = {
                apiKey: '', // Set your Gemini key here if loading this legacy plugin directly
                model: 'gemini-3.6-flash',
                panelVisible: false
            };

            var SYSTEM_PROMPT = 'You are KareTum Diagram AI. Generate valid draw.io XML (mxGraphModel format). RULES: 1. Always include mxCell id="0" and mxCell id="1" parent="0". 2. Style strings end with semicolon. 3. vertex="1" for shapes, edge="1" for connections. 4. Return ONLY valid XML, no markdown, no explanations. 5. Use html=1 in styles. 6. Proper spacing between elements (50px minimum). 7. Use unique numeric IDs for each cell (2, 3, 4, etc.).';

            function getXml() {
                try {
                    var xmlNode = editor.getGraphXml();
                    return mxUtils.getXml(xmlNode);
                } catch(e) { return null; }
            }

            function applyXml(xmlString) {
                try {
                    var doc = mxUtils.parseXml(xmlString);
                    var node = doc.documentElement;

                    // Use the same method draw.io uses for opening/importing files
                    editor.setGraphXml(node);
                    graph.fit();
                    graph.center();
                    return true;
                } catch(e) {
                    console.error('KareTum: Apply error', e);
                    return false;
                }
            }

            function addMessage(text, type) {
                var messages = document.getElementById('karetum-chat-messages');
                var msg = document.createElement('div');
                msg.className = 'karetum-msg ' + type;
                msg.textContent = text;
                messages.appendChild(msg);
                messages.scrollTop = messages.scrollHeight;
                return msg;
            }

            function addXmlMessage(text, xml) {
                var messages = document.getElementById('karetum-chat-messages');
                var msg = document.createElement('div');
                msg.className = 'karetum-msg bot';
                msg.innerHTML = '<div>' + text + '</div><button class="karetum-apply" data-xml="' + encodeURIComponent(xml) + '">Apply to Canvas</button>';
                messages.appendChild(msg);
                messages.scrollTop = messages.scrollHeight;
            }

            function showTyping() {
                var messages = document.getElementById('karetum-chat-messages');
                var typing = document.createElement('div');
                typing.id = 'karetum-typing';
                typing.className = 'karetum-msg bot thinking';
                typing.innerHTML = '<div class="karetum-dots"><div class="karetum-dot"></div><div class="karetum-dot"></div><div class="karetum-dot"></div></div>';
                messages.appendChild(typing);
                messages.scrollTop = messages.scrollHeight;
            }

            function hideTyping() {
                var t = document.getElementById('karetum-typing');
                if (t) t.remove();
            }

            async function callGemini(prompt, currentXml) {
                var fullPrompt = SYSTEM_PROMPT;
                if (currentXml) fullPrompt += '\n\nCURRENT DIAGRAM:\n' + currentXml;
                fullPrompt += '\n\nUSER REQUEST: ' + prompt;

                var response = await fetch('https://generativelanguage.googleapis.com/v1beta/models/' + CONFIG.model + ':generateContent?key=' + CONFIG.apiKey, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        contents: [{ parts: [{ text: fullPrompt }] }],
                        generationConfig: { temperature: 0.7, maxOutputTokens: 8192 }
                    })
                });

                if (!response.ok) {
                    var err = await response.json();
                    throw new Error(err.error ? err.error.message : 'API failed');
                }
                var data = await response.json();
                return data.candidates[0].content.parts[0].text;
            }

            function extractXml(text) {
                var m = text.match(/<mxGraphModel[\s\S]*<\/mxGraphModel>/);
                if (m) return m[0];
                m = text.match(/```(?:xml)?\s*\n?([\s\S]*?)\n?```/);
                if (m) {
                    var inner = m[1].match(/<mxGraphModel[\s\S]*<\/mxGraphModel>/);
                    if (inner) return inner[0];
                }
                return null;
            }

            async function sendMessage() {
                var input = document.getElementById('karetum-input');
                var prompt = input.value.trim();
                if (!prompt) return;

                addMessage(prompt, 'user');
                input.value = '';
                showTyping();

                try {
                    var currentXml = getXml();
                    var response = await callGemini(prompt, currentXml);
                    hideTyping();

                    var xml = extractXml(response);
                    var text = response.replace(/<mxGraphModel[\s\S]*<\/mxGraphModel>/g, '').replace(/```[\s\S]*?```/g, '').trim();
                    if (xml) {
                        addXmlMessage(text || 'Here is your diagram:', xml);
                    } else {
                        addMessage(response, 'assistant');
                    }
                } catch(e) {
                    hideTyping();
                    addMessage('Error: ' + e.message, 'assistant');
                }
            }

            function toggleChat() {
                var panel = document.getElementById('karetum-chat-panel');
                var btn = document.getElementById('karetum-floating-btn');
                CONFIG.panelVisible = !CONFIG.panelVisible;
                if (CONFIG.panelVisible) {
                    panel.classList.add('visible');
                    btn.style.display = 'none';
                } else {
                    panel.classList.remove('visible');
                    btn.style.display = 'flex';
                }
            }

            // Create floating button
            var btn = document.createElement('div');
            btn.id = 'karetum-floating-btn';
            btn.style.cssText = 'position:fixed;right:20px;bottom:20px;width:56px;height:56px;background:linear-gradient(135deg,#00d9ff,#0066ff);border-radius:50%;display:flex;align-items:center;justify-content:center;cursor:pointer;z-index:9999;box-shadow:0 4px 20px rgba(0,217,255,0.4);color:#fff;font-weight:bold;font-size:18px;';
            btn.textContent = 'AI';
            document.body.appendChild(btn);

            // Create chat panel
            var panel = document.createElement('div');
            panel.id = 'karetum-chat-panel';
            panel.innerHTML = '<div class="karetum-header"><span>KareTum Diagram AI</span><button class="karetum-close" id="karetum-close-btn">x</button></div>' +
                '<div class="karetum-messages" id="karetum-chat-messages">' +
                '<div class="karetum-welcome"><h3>Welcome to KareTum Diagram</h3><p>Describe the diagram you want, and AI will create it.</p>' +
                '<div class="karetum-tags"><button class="karetum-tag" data-prompt="Create a flowchart for user login">Flowchart</button>' +
                '<button class="karetum-tag" data-prompt="Create a sequence diagram for API calls">Sequence</button>' +
                '<button class="karetum-tag" data-prompt="Create a network diagram for a web app">Network</button>' +
                '<button class="karetum-tag" data-prompt="Create an ER diagram for a blog database">ER Diagram</button>' +
                '<button class="karetum-tag" data-prompt="Create a medallion architecture diagram">Medallion</button>' +
                '<button class="karetum-tag" data-prompt="Create a UML class diagram for e-commerce">UML Class</button></div></div></div>' +
                '<div class="karetum-input-area"><div class="karetum-input-row">' +
                '<textarea id="karetum-input" placeholder="Describe your diagram..." rows="2"></textarea>' +
                '<button class="karetum-send" id="karetum-send-btn">></button></div>' +
                '<div class="karetum-actions"><button class="karetum-act" id="karetum-export-xml">Export XML</button>' +
                '<button class="karetum-act" id="karetum-clear-btn">Clear Chat</button></div></div>';
            document.body.appendChild(panel);

            // Add CSS
            var style = document.createElement('style');
            style.textContent = '#karetum-chat-panel{position:fixed;right:0;top:48px;width:380px;height:calc(100% - 48px);background:#1a1a2e;z-index:10000;display:none;flex-direction:column;box-shadow:-2px 0 10px rgba(0,0,0,0.3);font-family:-apple-system,BlinkMacSystemFont,Segoe UI,Roboto,sans-serif;color:#e0e0e0}#karetum-chat-panel.visible{display:flex}.karetum-header{display:flex;justify-content:space-between;align-items:center;padding:12px 16px;background:#16213e;border-bottom:1px solid #0f3460}.karetum-header span{font-weight:600;font-size:14px;color:#00d9ff}.karetum-close{background:none;border:none;color:#888;font-size:24px;cursor:pointer}.karetum-close:hover{color:#fff}.karetum-messages{flex:1;overflow-y:auto;padding:16px;display:flex;flex-direction:column;gap:12px}.karetum-msg{padding:12px;border-radius:12px;font-size:13px;line-height:1.5;max-width:90%;white-space:pre-wrap}.karetum-msg.user{background:#0f3460;align-self:flex-end}.karetum-msg.bot{background:#16213e;align-self:flex-start}.karetum-msg.bot.thinking{border-left:3px solid #00d9ff}.karetum-welcome{text-align:center;padding:20px;color:#888}.karetum-welcome h3{color:#00d9ff;margin:0 0 8px 0}.karetum-welcome p{margin:0 0 16px 0;font-size:13px}.karetum-tags{display:flex;flex-wrap:wrap;gap:8px;justify-content:center}.karetum-tag{background:#16213e;border:1px solid #0f3460;color:#00d9ff;padding:8px 12px;border-radius:16px;font-size:12px;cursor:pointer}.karetum-tag:hover{background:#0f3460}.karetum-apply{background:#00d9ff;color:#000;border:none;padding:10px 20px;border-radius:6px;font-size:13px;font-weight:600;cursor:pointer;margin-top:10px;display:block;width:100%}.karetum-apply:hover{background:#00b8d4}.karetum-input-area{padding:12px 16px;background:#16213e;border-top:1px solid #0f3460}.karetum-input-row{display:flex;gap:8px}#karetum-input{flex:1;background:#1a1a2e;border:1px solid #0f3460;border-radius:12px;padding:10px 14px;color:#e0e0e0;font-size:13px;resize:none}#karetum-input:focus{outline:none;border-color:#00d9ff}.karetum-send{background:#00d9ff;border:none;border-radius:50%;width:40px;height:40px;cursor:pointer;color:#000;font-size:16px}.karetum-send:hover{background:#00b8d4}.karetum-actions{display:flex;gap:6px;margin-top:8px}.karetum-act{background:transparent;border:1px solid #0f3460;color:#888;padding:6px 10px;border-radius:6px;font-size:11px;cursor:pointer}.karetum-act:hover{background:#0f3460;color:#e0e0e0}.karetum-dots{display:flex;gap:4px;padding:12px}.karetum-dot{width:8px;height:8px;background:#00d9ff;border-radius:50%;animation:kbounce 1.4s infinite ease-in-out}.karetum-dot:nth-child(1){animation-delay:-.32s}.karetum-dot:nth-child(2){animation-delay:-.16s}@keyframes kbounce{0%,80%,100%{transform:scale(0)}40%{transform:scale(1)}}';
            document.head.appendChild(style);

            // Event listeners
            document.getElementById('karetum-close-btn').onclick = toggleChat;
            document.getElementById('karetum-send-btn').onclick = sendMessage;
            document.getElementById('karetum-input').onkeydown = function(e) {
                if (e.key === 'Enter' && !e.shiftKey) {
                    e.preventDefault();
                    sendMessage();
                }
            };

            btn.onclick = toggleChat;

            document.getElementById('karetum-chat-messages').onclick = function(e) {
                if (e.target.classList.contains('karetum-apply')) {
                    var xml = decodeURIComponent(e.target.getAttribute('data-xml'));
                    if (applyXml(xml)) {
                        addMessage('Diagram applied to canvas!', 'bot');
                    } else {
                        addMessage('Error applying diagram.', 'bot');
                    }
                }
                if (e.target.classList.contains('karetum-tag')) {
                    document.getElementById('karetum-input').value = e.target.getAttribute('data-prompt');
                    sendMessage();
                }
            };

            document.getElementById('karetum-export-xml').onclick = function() {
                var xml = getXml();
                if (xml) {
                    var blob = new Blob([xml], { type: 'application/xml' });
                    var a = document.createElement('a');
                    a.href = URL.createObjectURL(blob);
                    a.download = 'karetum-design.drawio';
                    a.click();
                }
            };

            document.getElementById('karetum-clear-btn').onclick = function() {
                document.getElementById('karetum-chat-messages').innerHTML = '<div class="karetum-welcome"><h3>Welcome to KareTum Diagram</h3><p>Describe the diagram you want, and AI will create it.</p></div>';
            };

            // Auto-open chat after 2 seconds
            setTimeout(function() {
                if (!CONFIG.panelVisible) toggleChat();
            }, 2000);

            // Register menu
            ui.actions.put('karetumChat', {
                label: 'KareTum Diagram AI',
                enabled: true,
                fn: toggleChat
            });

            console.log('KareTum Diagram AI plugin loaded successfully!');
        });
    }

    initPlugin();
})();
