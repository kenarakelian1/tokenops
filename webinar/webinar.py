"""TokenOps — a 30-second pitch.

Every figure spoken or shown here is real output from this repo, captured on
2026-08-19 by:

    node scripts/measure-session-rules.mjs --detail
    node scripts/measure-forecast.mjs

Nothing is illustrative. The terminal scene reproduces that output verbatim.
The numbers move as the underlying history moves, so the start screen labels
them as a point-in-time capture rather than a standing claim.

Built with the narrated-webinar Claude Code skill.
"""

META = {
    "title": "TokenOps",
    "eyebrow": "OPEN SOURCE",
    "subtitle": "I ran out of Claude Code usage three days before my limit reset. So I measured where it actually goes.",
    "preview": [
        {"num": "PART ONE", "title": "Three days early"},
        {"num": "PART TWO", "title": "Where it actually goes"},
        {"num": "PART THREE", "title": "Will I make it?"},
    ],
    "start_meta": "~30 seconds &middot; narrated &middot; 3 segments",
    "property_line": "TokenOps &middot; github.com/kenarakelian1/tokenops &middot; figures captured 2026-08-19",
    "sidebar_eyebrow": "Open Source",
    "sidebar_title": "TokenOps",
    "stage_property": "TokenOps &middot; measured, not estimated",
}

VOICE = {
    "id": "EXAVITQu4vr4xnSDxMaL",
    "model": "eleven_multilingual_v2",
    "settings": {
        "stability": 0.55,
        "similarity_boost": 0.8,
        "style": 0.22,
        "use_speaker_boost": True,
    },
}

SCENES = {
    # -------------------------------------------------------------- the wall
    "wall": {
        "html": """
        <div class="wall-bar">
          <div class="wall-fill"></div>
          <div class="wall-cut"></div>
        </div>
        <div class="wall-days">
          <span class="wall-day">MON</span><span class="wall-day">TUE</span>
          <span class="wall-day">WED</span><span class="wall-day">THU</span>
          <span class="wall-day wall-day-out">FRI</span>
          <span class="wall-day wall-day-out">SAT</span>
          <span class="wall-day wall-day-out">SUN</span>
        </div>
        <div class="wall-msg">Usage limit reached</div>
        <div class="wall-sub">3 days before reset</div>
        """,
        "css": """
        .scene-wall { display: flex; flex-direction: column; align-items: center; justify-content: center; }
        .scene-wall .wall-bar {
          position: relative; width: min(680px, 78%); height: 34px; border-radius: 6px;
          background: rgba(20, 35, 71, .55); border: 1px solid var(--border); overflow: hidden;
        }
        .scene-wall .wall-fill {
          position: absolute; top: 0; bottom: 0; left: 0; width: 0;
          background: linear-gradient(90deg, var(--gold) 0%, var(--gold-bright) 100%);
          transition: width 2.2s cubic-bezier(.4, 0, .2, 1);
        }
        .scene-wall.active .wall-fill { width: 57%; }
        .scene-wall .wall-cut {
          position: absolute; top: -6px; bottom: -6px; left: 57%; width: 2px;
          background: var(--red); opacity: 0; transition: opacity .5s ease .6s;
        }
        .scene-wall.active .wall-cut { opacity: 1; }
        .scene-wall .wall-days {
          display: flex; width: min(680px, 78%); margin-top: 10px;
          font: 600 11px/1 ui-monospace, Menlo, monospace; letter-spacing: .14em;
          color: var(--text-dimmer);
        }
        .scene-wall .wall-day { flex: 1; text-align: center; transition: color .6s ease 1.6s; }
        .scene-wall.active .wall-day-out { color: var(--red); }
        .scene-wall .wall-msg {
          margin-top: 38px; font: 700 26px/1.2 system-ui, sans-serif; color: var(--red);
          opacity: 0; transform: translateY(8px);
          transition: opacity .7s ease 1.9s, transform .7s ease 1.9s;
        }
        .scene-wall.active .wall-msg { opacity: 1; transform: none; }
        .scene-wall .wall-sub {
          margin-top: 8px; font: 500 15px/1.4 system-ui, sans-serif; color: var(--text-dim);
          opacity: 0; transition: opacity .7s ease 2.4s;
        }
        .scene-wall.active .wall-sub { opacity: 1; }
        """,
    },
    # ----------------------------------------------------------- the finding
    "finding": {
        "html": """
        <div class="find-term">
          <div class="find-bar">
            <span class="find-dot"></span><span class="find-dot"></span><span class="find-dot"></span>
            <span class="find-cmd">node scripts/measure-session-rules.mjs --detail</span>
          </div>
          <pre class="find-body"><span class="find-l find-l1">#1  <b class="find-warn">[WARN]</b> Long session re-reading a very large context</span><span class="find-l find-l2">    rule     session_context_ceiling</span><span class="find-l find-l3">    project  &hellip;GitHub-robotrepair</span><span class="find-l find-l4">    session  fa15ca56&hellip;  <b class="find-hot">665 turns over 594.8h</b>  &middot;  claude-opus-4-8</span><span class="find-l find-l5">    cost     <b class="find-hot">$215.22 API-equivalent</b>  &middot;  277.6M tokens involved</span><span class="find-l find-l6"> </span><span class="find-l find-l7">    447 of these 665 turns ran with a context at or above 300k</span><span class="find-l find-l8">    tokens, re-reading 277,579,133 cached tokens between them.</span></pre>
        </div>
        """,
        "css": """
        .scene-finding { display: flex; align-items: center; justify-content: center; }
        .scene-finding .find-term {
          width: min(880px, 94%); border-radius: 10px; overflow: hidden;
          background: #050a18; border: 1px solid var(--border);
          box-shadow: 0 24px 60px rgba(0, 0, 0, .5);
          opacity: 0; transform: translateY(14px);
          transition: opacity .8s ease, transform .8s ease;
        }
        .scene-finding.active .find-term { opacity: 1; transform: none; }
        .scene-finding .find-bar {
          display: flex; align-items: center; gap: 7px; padding: 10px 14px;
          background: rgba(20, 35, 71, .6); border-bottom: 1px solid var(--border);
        }
        .scene-finding .find-dot {
          width: 10px; height: 10px; border-radius: 50%; background: rgba(255, 255, 255, .16);
        }
        .scene-finding .find-cmd {
          margin-left: 10px; font: 500 12px/1 ui-monospace, Menlo, monospace; color: var(--text-dimmer);
        }
        .scene-finding .find-body {
          margin: 0; padding: 20px 22px; font: 400 14.5px/1.75 ui-monospace, Menlo, monospace;
          color: var(--text-dim); white-space: pre; overflow: hidden;
        }
        .scene-finding .find-l { display: block; opacity: 0; transition: opacity .45s ease; }
        .scene-finding.active .find-l { opacity: 1; }
        .scene-finding.active .find-l1 { transition-delay: .6s; }
        .scene-finding.active .find-l2 { transition-delay: .9s; }
        .scene-finding.active .find-l3 { transition-delay: 1.1s; }
        .scene-finding.active .find-l4 { transition-delay: 1.4s; }
        .scene-finding.active .find-l5 { transition-delay: 5.7s; }
        .scene-finding.active .find-l6,
        .scene-finding.active .find-l7 { transition-delay: 8.0s; }
        .scene-finding.active .find-l8 { transition-delay: 8.2s; }
        .scene-finding .find-warn { color: var(--gold-bright); font-weight: 600; }
        .scene-finding .find-hot { color: var(--text); font-weight: 600; transition: color .6s ease; }
        .scene-finding.hit .find-hot { color: var(--gold-bright); }
        """,
    },
    # ---------------------------------------------------------- the forecast
    "forecast": {
        "html": """
        <div class="fc-head">weekly_7d</div>
        <div class="fc-track"><div class="fc-fill"></div></div>
        <div class="fc-pct">51.6%</div>
        <div class="fc-cap">of your highest week ever <span class="fc-prov">[inferred]</span></div>
        <div class="fc-note">measured against your own history &mdash;<br>Anthropic publishes no quota for subscription plans</div>
        <div class="fc-local">runs locally &middot; nothing leaves the machine</div>
        """,
        "css": """
        .scene-forecast { display: flex; flex-direction: column; align-items: center; justify-content: center; }
        .scene-forecast .fc-head {
          font: 600 12px/1 ui-monospace, Menlo, monospace; letter-spacing: .18em;
          color: var(--text-dimmer); margin-bottom: 16px;
          opacity: 0; transition: opacity .6s ease .2s;
        }
        .scene-forecast.active .fc-head { opacity: 1; }
        .scene-forecast .fc-track {
          width: min(620px, 76%); height: 12px; border-radius: 6px;
          background: rgba(20, 35, 71, .6); border: 1px solid var(--border); overflow: hidden;
        }
        .scene-forecast .fc-fill {
          height: 100%; width: 0; border-radius: 6px;
          background: linear-gradient(90deg, var(--blue) 0%, var(--gold) 100%);
          transition: width 1.9s cubic-bezier(.4, 0, .2, 1) .5s;
        }
        .scene-forecast.active .fc-fill { width: 51.6%; }
        .scene-forecast .fc-pct {
          margin-top: 22px; font: 700 52px/1 system-ui, sans-serif; color: var(--text);
          opacity: 0; transform: translateY(8px);
          transition: opacity .7s ease 1.5s, transform .7s ease 1.5s;
        }
        .scene-forecast.active .fc-pct { opacity: 1; transform: none; }
        .scene-forecast .fc-cap {
          margin-top: 10px; font: 500 16px/1.4 system-ui, sans-serif; color: var(--text-dim);
          opacity: 0; transition: opacity .7s ease 1.9s;
        }
        .scene-forecast.active .fc-cap { opacity: 1; }
        .scene-forecast .fc-prov {
          font: 600 12px/1 ui-monospace, Menlo, monospace; color: var(--gold); letter-spacing: .08em;
        }
        .scene-forecast .fc-note {
          margin-top: 26px; text-align: center; font: 400 14px/1.6 system-ui, sans-serif;
          color: var(--text-dimmer); opacity: 0; transition: opacity .8s ease;
        }
        .scene-forecast.why .fc-note { opacity: 1; }
        .scene-forecast .fc-local {
          margin-top: 20px; font: 600 11px/1 ui-monospace, Menlo, monospace; letter-spacing: .14em;
          color: var(--green); opacity: 0; transition: opacity .8s ease;
        }
        .scene-forecast.local .fc-local { opacity: 1; }
        """,
    },
}

CHAPTERS = [
    {"number": 1, "title": "Three days early", "icon": "1", "segments": [
        {"id": "s1_wall", "scene": "wall",
         "narration": (
             "I ran out of Claude Code usage three days before my limit reset. "
             "So I built something to measure where it actually goes."
         )},
    ]},
    {"number": 2, "title": "Where it actually goes", "icon": "2", "segments": [
        # Cues derived from the MEASURED 10.4s narration, not a 150wpm
        # estimate: "Two hundred fifteen dollars" begins after 12 of 22
        # words (5.7s), the closing clause after 17 (8.0s).
        {"id": "s2_finding", "scene": "finding",
         "narration": (
             "One session: six hundred sixty-five turns, alive for five hundred "
             "ninety-four hours. Two hundred fifteen dollars, API-equivalent, "
             "just re-reading its own context."
         ),
         "timedClasses": [{"at": 5.7, "addClass": "hit"}]},
    ]},
    {"number": 3, "title": "Will I make it?", "icon": "3", "segments": [
        # Measured 11.6s / 30 words: "measured against my own history"
        # begins ~4.3s, "Runs locally" ~9.3s. Cues at 4.5s / 9.5s land just
        # after each phrase starts, which is what reads as synced.
        {"id": "s3_forecast", "scene": "forecast",
         "narration": (
             "Now it tells me I am at fifty-one percent of my heaviest week ever, "
             "measured against my own history, because Anthropic publishes no quota. "
             "Runs locally. Nothing leaves the machine."
         ),
         "timedClasses": [{"at": 4.5, "addClass": "why"},
                          {"at": 9.5, "addClass": "local"}]},
    ]},
]
