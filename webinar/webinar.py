"""TokenOps — a 30-second pitch (business framing).

Every figure spoken or shown is real, captured 2026-08-19 from the live
deployment at tokenops-web-production.up.railway.app. The two screenshots in
img/ are that dashboard, unretouched:

    img/overview.png         Overview — 30-day totals and model mix
    img/recommendations.png  Recommendations — findings, with assumptions

Money figures are estimated and API-equivalent, which is what the product
itself says on every card. The narration says "estimated" out loud rather
than implying banked savings, and never claims TokenOps knows a real quota.

Built with the narrated-webinar Claude Code skill.
"""

META = {
    "title": "TokenOps",
    "eyebrow": "OPEN SOURCE",
    "subtitle": "Your AI coding agents are spending real money. Nothing on the invoice tells you where it went.",
    "preview": [
        {"num": "PART ONE", "title": "Spend you cannot see"},
        {"num": "PART TWO", "title": "Metered where it happens"},
        {"num": "PART THREE", "title": "Told what to change"},
    ],
    "start_meta": "~30 seconds &middot; narrated &middot; 3 segments",
    "property_line": "TokenOps &middot; github.com/kenarakelian1/tokenops &middot; figures captured 2026-08-19",
    "sidebar_eyebrow": "Open Source",
    "sidebar_title": "TokenOps",
    "stage_property": "TokenOps &middot; estimated, API-equivalent &mdash; as labelled in-product",
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
    # -------------------------------------------------------------- the blind
    "blind": {
        "html": """
        <div class="bl-invoice">
          <div class="bl-inv-head">MONTHLY INVOICE</div>
          <div class="bl-inv-row"><span>AI coding assistants</span><span class="bl-amt">$5,003</span></div>
          <div class="bl-inv-rule"></div>
          <div class="bl-inv-q">Which model?</div>
          <div class="bl-inv-q">Which project?</div>
          <div class="bl-inv-q">Which of it was avoidable?</div>
        </div>
        <div class="bl-stamp">NO LINE ITEMS</div>
        """,
        "css": """
        .scene-blind { display: flex; flex-direction: column; align-items: center; justify-content: center; }
        .scene-blind .bl-invoice {
          width: min(520px, 72%); padding: 30px 34px; border-radius: 10px;
          background: rgba(20, 35, 71, .45); border: 1px solid var(--border);
          opacity: 0; transform: translateY(12px);
          transition: opacity .8s ease, transform .8s ease;
        }
        .scene-blind.active .bl-invoice { opacity: 1; transform: none; }
        .scene-blind .bl-inv-head {
          font: 600 11px/1 ui-monospace, Menlo, monospace; letter-spacing: .2em;
          color: var(--text-dimmer); margin-bottom: 20px;
        }
        .scene-blind .bl-inv-row {
          display: flex; justify-content: space-between; align-items: baseline;
          font: 500 17px/1.4 system-ui, sans-serif; color: var(--text);
        }
        .scene-blind .bl-amt { font-weight: 700; font-size: 30px; color: var(--gold-bright); }
        .scene-blind .bl-inv-rule { height: 1px; background: var(--border); margin: 22px 0 18px; }
        .scene-blind .bl-inv-q {
          font: 400 15px/1.9 system-ui, sans-serif; color: var(--text-dimmer);
          opacity: 0; transform: translateX(-6px);
          transition: opacity .55s ease, transform .55s ease;
        }
        .scene-blind.active .bl-inv-q { opacity: 1; transform: none; }
        .scene-blind.active .bl-inv-q:nth-of-type(1) { transition-delay: 4.4s; }
        .scene-blind.active .bl-inv-q:nth-of-type(2) { transition-delay: 5.1s; }
        .scene-blind.active .bl-inv-q:nth-of-type(3) { transition-delay: 5.8s; }
        .scene-blind .bl-stamp {
          margin-top: 30px; font: 700 13px/1 ui-monospace, Menlo, monospace;
          letter-spacing: .22em; color: var(--red);
          border: 2px solid var(--red); border-radius: 4px; padding: 9px 16px;
          transform: rotate(-3deg) scale(.9); opacity: 0;
          transition: opacity .6s ease 7.4s, transform .6s ease 7.4s;
        }
        .scene-blind.active .bl-stamp { opacity: .95; transform: rotate(-3deg) scale(1); }
        """,
    },
    # ----------------------------------------------------------- the overview
    "overview": {
        "html": """
        <div class="ov-shot">
          <img class="ov-img" src="img/overview.png" alt="TokenOps Overview: 30-day totals and model mix" />
          <div class="ov-ring"></div>
        </div>
        <div class="ov-cap">every request, metered on the machine it ran on</div>
        """,
        "css": """
        .scene-overview { display: flex; flex-direction: column; align-items: center; justify-content: center; }
        .scene-overview .ov-shot {
          position: relative; width: min(860px, 92%); border-radius: 10px; overflow: hidden;
          border: 1px solid var(--border); box-shadow: 0 24px 60px rgba(0, 0, 0, .55);
          opacity: 0; transform: translateY(14px) scale(.985);
          transition: opacity .9s ease, transform .9s ease;
        }
        .scene-overview.active .ov-shot { opacity: 1; transform: none; }
        .scene-overview .ov-img { display: block; width: 100%; height: auto; }
        /* Over the "Last 30 days" card. These percentages are MEASURED, not
           estimated: source-pixel corners (948,232)-(1192,352) in the 1220x942
           screenshot, mapped through the rendered image's own bounding box.
           Eyeballed values put the ring above the figure it highlights. */
        .scene-overview .ov-ring {
          position: absolute; left: 72%; top: 30.4%; width: 26.2%; height: 17.6%;
          border: 2px solid var(--gold-bright); border-radius: 8px;
          box-shadow: 0 0 0 9999px rgba(5, 10, 24, .58);
          opacity: 0; transform: scale(1.08);
          transition: opacity .7s ease, transform .7s ease;
        }
        .scene-overview.spot .ov-ring { opacity: 1; transform: none; }
        .scene-overview .ov-cap {
          margin-top: 18px; font: 500 14px/1.5 system-ui, sans-serif; color: var(--text-dim);
          opacity: 0; transition: opacity .7s ease 1.1s;
        }
        .scene-overview.active .ov-cap { opacity: 1; }
        """,
    },
    # ----------------------------------------------------------- the findings
    "findings": {
        "html": """
        <div class="fd-shot">
          <img class="fd-img" src="img/recommendations.png" alt="TokenOps Recommendations: findings with estimated savings and stated assumptions" />
          <div class="fd-ring"></div>
        </div>
        <div class="fd-cap">each card states its assumption &mdash; and what it does not cover</div>
        """,
        "css": """
        .scene-findings { display: flex; flex-direction: column; align-items: center; justify-content: center; }
        .scene-findings .fd-shot {
          position: relative; width: min(860px, 92%); border-radius: 10px; overflow: hidden;
          border: 1px solid var(--border); box-shadow: 0 24px 60px rgba(0, 0, 0, .55);
          opacity: 0; transform: translateY(14px) scale(.985);
          transition: opacity .9s ease, transform .9s ease;
        }
        .scene-findings.active .fd-shot { opacity: 1; transform: none; }
        .scene-findings .fd-img { display: block; width: 100%; height: auto; }
        /* Over the first card's "Est. savings: $922.5290" line. Measured the
           same way: source corners (392,408)-(712,436), padded slightly so the
           ring clears the text rather than cropping it. */
        .scene-findings .fd-ring {
          position: absolute; left: 34.3%; top: 54.2%; width: 28.1%; height: 5.1%;
          border: 2px solid var(--gold-bright); border-radius: 6px;
          box-shadow: 0 0 0 9999px rgba(5, 10, 24, .58);
          opacity: 0; transform: scale(1.06);
          transition: opacity .7s ease, transform .7s ease;
        }
        .scene-findings.spot .fd-ring { opacity: 1; transform: none; }
        .scene-findings .fd-cap {
          margin-top: 18px; font: 500 14px/1.5 system-ui, sans-serif; color: var(--text-dim);
          opacity: 0; transition: opacity .8s ease;
        }
        .scene-findings.honest .fd-cap { opacity: 1; }
        """,
    },
}

CHAPTERS = [
    {"number": 1, "title": "Spend you cannot see", "icon": "1", "segments": [
        # Every cue below is derived from the MEASURED narration (8.4 / 9.5
        # / 11.6s), by word position within each line — not from a words-per
        # -minute estimate. The previous cut was written at an assumed 150wpm
        # and every cue fired about a second early.
        {"id": "s1_blind", "scene": "blind",
         "narration": (
             "Your AI coding agents are spending real money. The invoice shows a "
             "total — not which model, which project, or which of it was "
             "avoidable."
         )},
    ]},
    {"number": 2, "title": "Metered where it happens", "icon": "2", "segments": [
        {"id": "s2_overview", "scene": "overview",
         "narration": (
             "TokenOps meters every request on the machine it runs on. Five "
             "thousand dollars across thirty days, broken down by model, machine "
             "and project."
         ),
         "timedClasses": [{"at": 4.6, "addClass": "spot"}]},
    ]},
    {"number": 3, "title": "Told what to change", "icon": "3", "segments": [
        {"id": "s3_findings", "scene": "findings",
         "narration": (
             "Then it names what to change. Eighty-four percent of tokens went to "
             "frontier models: nine hundred twenty-two dollars, estimated, in one "
             "finding. Every card shows its assumption."
         ),
         "timedClasses": [{"at": 6.0, "addClass": "spot"},
                          {"at": 9.5, "addClass": "honest"}]},
    ]},
]
