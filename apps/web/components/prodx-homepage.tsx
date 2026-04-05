"use client";

import { ArrowRight, Download, FileText, PackageCheck, TerminalSquare, Package, Shirt, Box } from "lucide-react";
import { motion } from "framer-motion";

const quickStart = [
  'git clone https://github.com/BlyzrHQ/catalogue-Manager.git',
  'cd shopify-catalog-toolkit',
  "npm install",
  "npm run build"
];

const exampleCommands = [
  'node .\\dist\\cli.js init',
  'node .\\dist\\cli.js workflow run --input .\\examples\\grocery\\products-match.json --catalog .\\examples\\grocery\\catalog-match.json',
  'node .\\dist\\cli.js review queue'
];

const outputs = [
  {
    title: "Prodx Guide",
    body: "A practical guide for how your catalog should be written, structured, and reviewed."
  },
  {
    title: "Shopify Import",
    body: "A clean CSV with approved products only, ready to import into Shopify when you are."
  },
  {
    title: "Workflow Summary",
    body: "A clear summary of what passed, what was skipped, what became a variant, and what needs attention."
  }
];

const tickerMessages = [
  "Less cleanup",
  "Fewer mistakes",
  "Better catalog handoffs"
];

export function ProdxHomepage() {
  return (
    <main className="homepageShell">
      <style dangerouslySetInnerHTML={{__html: `
        .customHero {
          background-color: var(--surface-soft);
          padding: 56px 80px 72px;
          gap: 48px;
          border-radius: 0;
          border: none;
          box-shadow: none;
          width: 100%;
          box-sizing: border-box;
        }
        .customHeroCopy {
          gap: 32px;
        }
        .customHeroTitle {
          font-family: Inter, sans-serif;
          font-size: 52px;
          font-weight: 800;
          line-height: 1.1;
          color: var(--ink);
          margin: 0;
          max-width: none;
        }
        .customHeroBody {
          font-family: Geist, sans-serif;
          font-size: 18px;
          font-weight: normal;
          line-height: 1.6;
          color: var(--secondary);
          margin: 0;
          max-width: none;
        }
        .customHeroActions {
          gap: 16px;
        }
        .customPrimaryBtn {
          font-family: Geist, sans-serif;
          font-size: 16px;
          font-weight: 600;
          padding: 14px 32px;
          border-radius: 9999px;
          background: var(--primary);
          color: #fff;
        }
        .quickstartSection {
          background-color: var(--ink);
          border-radius: 24px;
          padding: 64px 48px;
          display: flex;
          flex-direction: column;
          gap: 48px;
          color: #fff;
          margin: 0 24px;
        }
        .outputsSection {
          padding: 80px 48px;
          display: flex;
          flex-direction: column;
          align-items: center;
          gap: 48px;
        }
        @media (max-width: 860px) {
          .step-arrow-icon { display: none !important; }
          .customHero {
            padding: 28px 20px 40px !important;
            gap: 32px !important;
            display: flex !important;
            flex-direction: column !important;
          }
          .customHeroTitle {
            font-size: 36px !important;
          }
          .customHeroBody {
            font-size: 16px !important;
          }
          .customHeroActions {
            flex-direction: column;
            width: 100%;
          }
          .customHeroActions a {
            width: 100%;
            text-align: center;
          }
          .homepageTopbar {
            flex-direction: row !important;
            align-items: center !important;
            justify-content: center !important;
            gap: 16px;
            padding: 16px 20px !important;
          }
          .homepageTopbar a {
            width: auto !important;
            text-align: center;
          }
          .quickstartSection {
            padding: 40px 20px !important;
            margin: 0 !important;
            border-radius: 16px !important;
          }
          .outputsSection {
            padding: 40px 20px !important;
          }
          .howItWorksSection {
            padding: 40px 20px !important;
          }
        }
      `}} />
      <header className="homepageTopbar" style={{ background: "var(--surface-soft)", border: "none", padding: "16px 24px", borderRadius: "16px", justifyContent: "center" }}>
        <div className="brandLockup">
          <div>
            <strong style={{ fontSize: "32px", fontFamily: "Inter, sans-serif", fontWeight: 800 }}>Prodx</strong>
          </div>
        </div>
      </header>

      <motion.section 
        className="homepageHero customHero"
        initial={{ opacity: 0, y: 20 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.6 }}
      >
        <div className="homepageHeroCopy customHeroCopy">
          <h1 className="customHeroTitle">
            Clean up your product data before it reaches Shopify
          </h1>
          <p className="heroBody customHeroBody">
            Prodx helps you take raw product lists, fill the important gaps, catch risky issues early, and end up with files you can actually use.
          </p>
          <div className="heroActions customHeroActions">
            <a className="button isPrimary customPrimaryBtn" href="#quickstart">
              Download and run it
            </a>
          </div>
        </div>

        <div className="homepageHeroPanel" style={{ backgroundColor: "#fff", borderRadius: "16px", padding: "24px", gap: "16px", boxShadow: "0 1px 2px rgba(0,0,0,0.04)" }}>
          <div className="homepageHeroPanelHeader" style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <span style={{ fontFamily: "Inter, sans-serif", fontSize: "14px", fontWeight: 600, color: "var(--ink)" }}>Product Catalog</span>
            <span style={{ backgroundColor: "var(--primary-soft)", color: "var(--primary)", padding: "4px 10px", borderRadius: "9999px", fontFamily: "Geist, sans-serif", fontSize: "12px", fontWeight: 500 }}>12 items</span>
          </div>
          <div className="homepageHeroList" style={{ gap: "16px" }}>
            <div className="homepageHeroItem" style={{ backgroundColor: "var(--surface-soft)", borderRadius: "12px", padding: "16px", gap: "16px" }}>
              <div className="heroPreviewIcon" style={{ backgroundColor: "var(--primary-soft)", color: "var(--primary)", width: "56px", height: "56px", borderRadius: "8px", flexShrink: 0 }}>
                <Package size={24} />
              </div>
              <div style={{ flex: 1, display: "flex", flexDirection: "column", gap: "4px" }}>
                <strong style={{ fontFamily: "Geist, sans-serif", fontSize: "14px", fontWeight: 500, color: "var(--ink)" }}>Organic Cotton T-Shirt</strong>
                <p style={{ fontFamily: "IBM Plex Mono, monospace", fontSize: "11px", fontWeight: "normal", color: "var(--muted)", margin: 0 }}>SKU: OCT-2024-BLK</p>
              </div>
              <span style={{ backgroundColor: "#d1fae5", color: "#059669", padding: "4px 10px", borderRadius: "9999px", fontFamily: "Geist, sans-serif", fontSize: "11px", fontWeight: 600 }}>Approved</span>
            </div>
            <div className="homepageHeroItem" style={{ backgroundColor: "var(--surface-soft)", borderRadius: "12px", padding: "16px", gap: "16px" }}>
              <div className="heroPreviewIcon" style={{ backgroundColor: "var(--primary-soft)", color: "var(--primary)", width: "56px", height: "56px", borderRadius: "8px", flexShrink: 0 }}>
                <Shirt size={24} />
              </div>
              <div style={{ flex: 1, display: "flex", flexDirection: "column", gap: "4px" }}>
                <strong style={{ fontFamily: "Geist, sans-serif", fontSize: "14px", fontWeight: 500, color: "var(--ink)" }}>Merino Wool Sweater</strong>
                <p style={{ fontFamily: "IBM Plex Mono, monospace", fontSize: "11px", fontWeight: "normal", color: "var(--muted)", margin: 0 }}>SKU: MWS-2024-NAV</p>
              </div>
              <span style={{ backgroundColor: "#fef3c7", color: "#d97706", padding: "4px 10px", borderRadius: "9999px", fontFamily: "Geist, sans-serif", fontSize: "11px", fontWeight: 600 }}>Pending</span>
            </div>
            <div className="homepageHeroItem" style={{ backgroundColor: "var(--surface-soft)", borderRadius: "12px", padding: "16px", gap: "16px" }}>
              <div className="heroPreviewIcon" style={{ backgroundColor: "var(--primary-soft)", color: "var(--primary)", width: "56px", height: "56px", borderRadius: "8px", flexShrink: 0 }}>
                <Box size={24} />
              </div>
              <div style={{ flex: 1, display: "flex", flexDirection: "column", gap: "4px" }}>
                <strong style={{ fontFamily: "Geist, sans-serif", fontSize: "14px", fontWeight: 500, color: "var(--ink)" }}>Canvas Tote Bag</strong>
                <p style={{ fontFamily: "IBM Plex Mono, monospace", fontSize: "11px", fontWeight: "normal", color: "var(--muted)", margin: 0 }}>SKU: CTB-2024-TAN</p>
              </div>
              <span style={{ backgroundColor: "#d1fae5", color: "#059669", padding: "4px 10px", borderRadius: "9999px", fontFamily: "Geist, sans-serif", fontSize: "11px", fontWeight: 600 }}>Approved</span>
            </div>
          </div>
        </div>
      </motion.section>

      <div style={{ width: "100vw", position: "relative", left: "50%", right: "50%", marginLeft: "-50vw", marginRight: "-50vw", overflow: "hidden", background: "var(--primary)", padding: "18px 0", display: "flex", whiteSpace: "nowrap" }}>
        <motion.div 
          animate={{ x: [0, -1000] }} 
          transition={{ repeat: Infinity, ease: "linear", duration: 20 }}
          style={{ display: "flex", gap: "40px" }}
        >
          {Array.from({ length: 6 }, (_, repeatIndex) =>
            tickerMessages.map((text, messageIndex) => (
              <span
                key={`${repeatIndex}-${messageIndex}`}
                style={{ display: "inline-flex", alignItems: "center", gap: "18px" }}
              >
                <span
                  style={{ fontFamily: "IBM Plex Mono, monospace", fontSize: "18px", fontWeight: 700, color: "rgba(255,255,255,0.92)", textTransform: "uppercase", letterSpacing: "0.05em" }}
                >
                  {text}
                </span>
                <span
                  aria-hidden="true"
                  style={{ width: "9px", height: "9px", borderRadius: "9999px", border: "1.5px solid rgba(255,255,255,0.72)", background: "transparent", display: "inline-block" }}
                />
              </span>
            ))
          )}
        </motion.div>
      </div>

      <motion.section 
        className="howItWorksSection" 
        style={{ padding: "80px 0", display: "flex", flexDirection: "column", alignItems: "center", gap: "48px", backgroundColor: "var(--surface-soft)" }}
        initial={{ opacity: 0, y: 30 }}
        whileInView={{ opacity: 1, y: 0 }}
        viewport={{ once: true, margin: "-100px" }}
        transition={{ duration: 0.6 }}
      >
        <h2 style={{ fontFamily: "Inter, sans-serif", fontSize: "36px", fontWeight: 700, color: "var(--ink)", margin: 0, textAlign: "center" }}>
          How Prodx works
        </h2>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "center", width: "100%", maxWidth: "1200px", gap: "16px", flexWrap: "wrap" }}>
          <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: "20px", flex: 1, minWidth: "250px", padding: "0 16px", textAlign: "center" }}>
            <div style={{ fontFamily: "IBM Plex Mono, monospace", fontSize: "48px", fontWeight: 700, color: "var(--primary)" }}>01</div>
            <h3 style={{ fontFamily: "Inter, sans-serif", fontSize: "18px", fontWeight: 600, color: "var(--ink)", margin: 0 }}>Set up your workspace</h3>
            <p style={{ fontFamily: "Geist, sans-serif", fontSize: "14px", lineHeight: 1.6, color: "var(--secondary)", margin: 0 }}>
              Generate your guide, choose your providers, and define the rules your catalog should follow.
            </p>
          </div>
          
          <ArrowRight size={32} color="var(--muted)" className="step-arrow-icon" />

          <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: "20px", flex: 1, minWidth: "250px", padding: "0 16px", textAlign: "center" }}>
            <div style={{ fontFamily: "IBM Plex Mono, monospace", fontSize: "48px", fontWeight: 700, color: "var(--primary)" }}>02</div>
            <h3 style={{ fontFamily: "Inter, sans-serif", fontSize: "18px", fontWeight: 600, color: "var(--ink)", margin: 0 }}>Run the workflow</h3>
            <p style={{ fontFamily: "Geist, sans-serif", fontSize: "14px", lineHeight: 1.6, color: "var(--secondary)", margin: 0 }}>
              Feed in your products and let Prodx match, enrich, validate, and prepare them step by step.
            </p>
          </div>

          <ArrowRight size={32} color="var(--muted)" className="step-arrow-icon" />

          <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: "20px", flex: 1, minWidth: "250px", padding: "0 16px", textAlign: "center" }}>
            <div style={{ fontFamily: "IBM Plex Mono, monospace", fontSize: "48px", fontWeight: 700, color: "var(--primary)" }}>03</div>
            <h3 style={{ fontFamily: "Inter, sans-serif", fontSize: "18px", fontWeight: 600, color: "var(--ink)", margin: 0 }}>Review the result</h3>
            <p style={{ fontFamily: "Geist, sans-serif", fontSize: "14px", lineHeight: 1.6, color: "var(--secondary)", margin: 0 }}>
              Check flagged items, keep the good output, and move forward with a cleaner Shopify import.
            </p>
          </div>
        </div>
      </motion.section>

      <motion.section 
        id="quickstart" 
        className="quickstartSection"
        initial={{ opacity: 0, y: 30 }}
        whileInView={{ opacity: 1, y: 0 }}
        viewport={{ once: true, margin: "-100px" }}
        transition={{ duration: 0.6 }}
      >
        <div style={{ textAlign: "center", display: "flex", flexDirection: "column", alignItems: "center", gap: "16px" }}>
          <span style={{ backgroundColor: "rgba(255,255,255,0.1)", color: "#fff", padding: "6px 16px", borderRadius: "999px", fontSize: "14px", fontFamily: "var(--font-display)", fontStyle: "italic" }}>
            Quick start
          </span>
          <h2 style={{ fontFamily: "Inter, sans-serif", fontSize: "32px", fontWeight: 600, margin: 0 }}>
            Download and run locally
          </h2>
          <p style={{ color: "#9CA89C", fontSize: "16px", margin: 0, maxWidth: "600px" }}>
            Start with these commands to get Prodx running on your machine and test the workflow end to end.
          </p>
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 300px), 1fr))", gap: "24px" }}>
          <article style={{ backgroundColor: "#2A4A32", padding: "32px", borderRadius: "16px", display: "flex", flexDirection: "column", gap: "16px" }}>
            <div style={{ display: "flex", alignItems: "center", gap: "10px", color: "#fff" }}>
              <div style={{ width: "40px", height: "40px", backgroundColor: "rgba(255,255,255,0.1)", borderRadius: "12px", display: "flex", alignItems: "center", justifyContent: "center" }}>
                <Download size={20} color="#fff" />
              </div>
              <strong style={{ fontSize: "20px", fontWeight: 600 }}>Install</strong>
            </div>
            <div style={{ display: "grid", gap: "10px" }}>
              {quickStart.map((command) => (
                <code key={command} style={{ display: "block", padding: "12px 14px", borderRadius: "12px", background: "rgba(16, 27, 19, 0.34)", color: "#fff", fontFamily: "monospace", fontSize: "14px", wordBreak: "break-word" }}>
                  {command}
                </code>
              ))}
            </div>
          </article>
          <article id="commands" style={{ backgroundColor: "#2A4A32", padding: "32px", borderRadius: "16px", display: "flex", flexDirection: "column", gap: "16px" }}>
            <div style={{ display: "flex", alignItems: "center", gap: "10px", color: "#fff" }}>
              <div style={{ width: "40px", height: "40px", backgroundColor: "rgba(255,255,255,0.1)", borderRadius: "12px", display: "flex", alignItems: "center", justifyContent: "center" }}>
                <TerminalSquare size={20} color="#fff" />
              </div>
              <strong style={{ fontSize: "20px", fontWeight: 600 }}>Run the workflow</strong>
            </div>
            <div style={{ display: "grid", gap: "10px" }}>
              {exampleCommands.map((command) => (
                <code key={command} style={{ display: "block", padding: "12px 14px", borderRadius: "12px", background: "rgba(16, 27, 19, 0.34)", color: "#fff", fontFamily: "monospace", fontSize: "14px", wordBreak: "break-word" }}>
                  {command}
                </code>
              ))}
            </div>
          </article>
        </div>
      </motion.section>

      <motion.section 
        className="outputsSection"
        initial={{ opacity: 0, y: 30 }}
        whileInView={{ opacity: 1, y: 0 }}
        viewport={{ once: true, margin: "-100px" }}
        transition={{ duration: 0.6 }}
      >
        <div style={{ textAlign: "center", display: "flex", flexDirection: "column", alignItems: "center", gap: "16px" }}>
          <span style={{ backgroundColor: "var(--primary-soft)", color: "var(--primary)", padding: "6px 16px", borderRadius: "999px", fontSize: "14px", fontWeight: 600 }}>
            Outputs
          </span>
          <h2 style={{ fontFamily: "Inter, sans-serif", fontSize: "32px", fontWeight: 600, color: "var(--ink)", margin: 0 }}>
            What you get at the end
          </h2>
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 250px), 1fr))", gap: "16px", width: "100%", maxWidth: "1200px" }}>
          {outputs.map((item) => (
            <article key={item.title} style={{ backgroundColor: "#fff", padding: "32px", borderRadius: "16px", border: "1px solid var(--line)", display: "flex", flexDirection: "column", gap: "16px" }}>
              <div style={{ width: "48px", height: "48px", borderRadius: "999px", backgroundColor: "var(--primary-soft)", display: "flex", alignItems: "center", justifyContent: "center", color: "var(--primary)" }}>
                <FileText size={24} />
              </div>
              <strong style={{ fontSize: "20px", fontWeight: 600, color: "var(--ink)", margin: 0 }}>{item.title}</strong>
              <p style={{ fontSize: "14px", lineHeight: 1.6, color: "var(--secondary)", margin: 0 }}>{item.body}</p>
            </article>
          ))}
        </div>
      </motion.section>

      <footer style={{ display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", padding: "32px 20px 24px", gap: "12px", borderTop: "1px solid var(--line)", marginTop: "24px" }}>
        <strong style={{ fontSize: "24px", fontFamily: "Inter, sans-serif", fontWeight: 800, color: "var(--ink)" }}>Prodx</strong>
        <p style={{ fontSize: "14px", color: "var(--secondary)", fontFamily: "Geist, sans-serif", margin: 0 }}>© Copyright 2026 Prodx</p>
      </footer>
    </main>
  );
}
