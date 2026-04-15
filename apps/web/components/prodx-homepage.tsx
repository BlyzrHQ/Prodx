"use client";

import {
  ArrowRight,
  Bot,
  Check,
  Copy,
  Cpu,
  Download,
  Eye,
  FileText,
  Globe,
  Package,
  ShoppingBag,
  TerminalSquare
} from "lucide-react";
import { motion } from "framer-motion";
import { useState } from "react";

const quickStart = [
  "git clone https://github.com/BlyzrHQ/prodx.git",
  "cd prodx",
  "npm install",
  "npm run setup"
];

const exampleCommands = [
  "npx tsx src/cli.ts add --file ./products.csv",
  "npx tsx src/cli.ts sync",
  "npx tsx src/cli.ts run pipeline",
  "npx tsx src/cli.ts publish",
  "/prodx-cpo check catalog status"
];

const pipelineSteps = [
  { title: "Analyze", desc: "Parse CSV, text, or product images with AI." },
  { title: "Match", desc: "Detect duplicates, variants, and existing catalog overlap." },
  { title: "Enrich", desc: "Generate titles, descriptions, SEO, and metafield-ready data." },
  { title: "Optimize", desc: "Find the strongest images and improve listing quality." },
  { title: "QA", desc: "Score every product against your catalog guide rules." },
  { title: "Publish", desc: "Push approved products back into Shopify with confidence." }
];

const features = [
  {
    icon: Bot,
    title: "AI-Powered Agents",
    body: "Specialized agents handle analysis, matching, enrichment, image work, QA scoring, and orchestration."
  },
  {
    icon: ShoppingBag,
    title: "Shopify Native",
    body: "Sync your store catalog, variants, metafields, and publish approved products back through Shopify APIs."
  },
  {
    icon: Cpu,
    title: "Background Tasks",
    body: "Long-running enrichment, image, and QA work runs asynchronously so large batches stay manageable."
  },
  {
    icon: Globe,
    title: "Web Research",
    body: "The pipeline can research details from trusted sources instead of filling gaps with guesses."
  },
  {
    icon: Eye,
    title: "Catalog Guide",
    body: "Your own rules decide tone, structure, quality thresholds, and what counts as publish-ready."
  },
  {
    icon: FileText,
    title: "Operator-Friendly",
    body: "Run it from the CLI, monitor batches, and manage the catalog with your CPO workflow."
  }
];

const tools = [
  { name: "Convex", url: "https://convex.dev", role: "Database + Vector Search" },
  { name: "Trigger.dev", url: "https://trigger.dev", role: "Background Tasks" },
  { name: "OpenAI", url: "https://openai.com", role: "LLM + Vision" },
  { name: "Shopify", url: "https://shopify.com", role: "E-commerce" },
  { name: "Serper", url: "https://serper.dev", role: "Image Search" },
  { name: "Gemini", url: "https://ai.google.dev", role: "LLM Provider" },
  { name: "Anthropic", url: "https://anthropic.com", role: "LLM Provider" }
];

const tickerMessages = [
  "AI-powered catalog management",
  "Duplicate detection",
  "Smart enrichment",
  "Quality assurance",
  "Shopify native",
  "Open source"
];

const sectionHeaderStyle = {
  width: "100%",
  textAlign: "center" as const,
  display: "flex",
  flexDirection: "column" as const,
  alignItems: "center" as const,
  gap: "16px"
};

const sectionBadgeStyle = {
  backgroundColor: "var(--primary-soft)",
  color: "var(--primary)",
  padding: "6px 16px",
  borderRadius: "999px",
  fontFamily: "var(--font-body)",
  fontSize: "14px",
  fontWeight: 600
};

const sectionTitleStyle = {
  width: "fit-content",
  maxWidth: "100%",
  display: "block",
  marginLeft: "auto",
  marginRight: "auto",
  textAlign: "center" as const,
  fontFamily: "var(--font-display)",
  fontSize: "32px",
  fontWeight: 700,
  color: "var(--ink)",
  marginTop: 0,
  marginBottom: 0,
  textWrap: "balance" as const,
  fontKerning: "normal" as const,
  textRendering: "optimizeLegibility" as const
};

const sectionIntroStyle = {
  fontFamily: "var(--font-body)",
  fontSize: "16px",
  lineHeight: 1.6,
  color: "var(--secondary)",
  margin: 0
};

const contentWidthStyle = {
  width: "min(1120px, calc(100% - 24px))",
  marginLeft: "auto",
  marginRight: "auto"
};

export function ProdxHomepage() {
  const [copiedCommand, setCopiedCommand] = useState<string | null>(null);

  async function handleCopy(command: string) {
    try {
      await navigator.clipboard.writeText(command);
      setCopiedCommand(command);
      window.setTimeout(() => {
        setCopiedCommand((current) => (current === command ? null : current));
      }, 1800);
    } catch {
      setCopiedCommand(null);
    }
  }

  return (
    <main className="homepageShell" style={{ width: "100%", maxWidth: "none", margin: 0, gap: "20px" }}>
      <style
        dangerouslySetInnerHTML={{
          __html: `
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
          font-family: var(--font-display);
          font-size: 52px;
          font-weight: 800;
          line-height: 1.1;
          color: var(--ink);
          margin: 0;
          max-width: none;
        }
        .customHeroBody {
          font-family: var(--font-body);
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
          font-family: var(--font-body);
          font-size: 16px;
          font-weight: 600;
          padding: 14px 32px;
          border-radius: 9999px;
          background: var(--primary);
          color: #fff;
          text-decoration: none;
        }
        .customSecondaryBtn {
          font-family: var(--font-body);
          font-size: 16px;
          font-weight: 600;
          padding: 14px 32px;
          border-radius: 9999px;
          background: transparent;
          color: var(--ink);
          border: 1px solid var(--line);
          text-decoration: none;
          display: inline-flex;
          align-items: center;
          gap: 8px;
        }
        .pipelineSection {
          padding: 56px 0 64px;
          display: flex;
          flex-direction: column;
          align-items: center;
          gap: 24px;
          background-color: var(--surface-soft);
        }
        .sectionHeader {
          max-width: 720px;
        }
        .sectionTitle {
          letter-spacing: -0.015em;
        }
        .sectionIntro {
          max-width: 640px;
          text-align: center;
        }
        .pipelineRail {
          display: flex;
          align-items: center;
          justify-content: center;
          width: 100%;
          max-width: 1320px;
          gap: 16px;
        }
        .pipelineStep {
          display: flex;
          flex-direction: column;
          align-items: center;
          gap: 20px;
          flex: 1 1 0;
          min-width: 0;
          padding: 0 8px;
          text-align: center;
        }
        .pipelineStepNumber {
          font-family: var(--font-mono);
          font-size: 40px;
          font-weight: 700;
          color: var(--primary);
          line-height: 1;
        }
        .pipelineStepTitle {
          letter-spacing: -0.02em;
        }
        .pipelineArrow {
          display: flex;
          align-items: center;
          justify-content: center;
          color: var(--muted);
          flex: 0 0 auto;
        }
        .quickstartGrid {
          display: grid;
          grid-template-columns: repeat(auto-fit, minmax(min(100%, 300px), 1fr));
          gap: 24px;
        }
        .quickstartCard {
          background-color: #2A4A32;
          padding: 32px;
          border-radius: 16px;
          display: flex;
          flex-direction: column;
          gap: 16px;
        }
        .quickstartCardTitle {
          font-size: 20px;
          font-weight: 600;
        }
        .commandList {
          display: grid;
          gap: 10px;
        }
        .commandField {
          position: relative;
        }
        .commandCode {
          display: block;
          width: 100%;
          padding: 12px 14px;
          padding-right: 54px;
          border-radius: 12px;
          background: rgba(16, 27, 19, 0.34);
          color: #fff;
          font-family: monospace;
          font-size: 14px;
          word-break: break-word;
        }
        .copyButton {
          position: absolute;
          top: 50%;
          right: 8px;
          transform: translateY(-50%);
          width: 28px;
          min-width: 28px;
          border: 0;
          padding: 0;
          background: transparent;
          color: rgba(255,255,255,0.78);
          display: inline-flex;
          align-items: center;
          justify-content: center;
          cursor: pointer;
          transition: color 140ms ease, opacity 140ms ease;
        }
        .copyButton:hover {
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
          width: min(1120px, calc(100% - 24px));
          margin-left: auto;
          margin-right: auto;
        }
        .quickstartHeader {
          width: 100%;
          max-width: 760px;
          margin-left: auto;
          margin-right: auto;
        }
        .quickstartTitle {
          width: 100% !important;
          max-width: 100% !important;
          margin-left: 0 !important;
          margin-right: 0 !important;
          text-align: center !important;
        }
        .featuresSection,
        .toolsSection {
          width: min(1120px, calc(100% - 24px));
          margin-left: auto;
          margin-right: auto;
          padding: 80px 0;
          display: flex;
          flex-direction: column;
          align-items: center;
          gap: 48px;
        }
        .featuresGrid {
          display: grid;
          grid-template-columns: repeat(3, minmax(0, 1fr));
          gap: 16px;
          width: 100%;
          max-width: 1200px;
        }
        .featureCard {
          background-color: #fff;
          padding: 32px;
          border-radius: 16px;
          border: 1px solid var(--line);
          display: flex;
          flex-direction: column;
          gap: 16px;
        }
        .toolsGrid {
          display: grid;
          grid-template-columns: repeat(4, minmax(0, 1fr));
          gap: 16px;
          width: 100%;
          max-width: 1200px;
        }
        .toolCard {
          display: flex;
          flex-direction: column;
          align-items: center;
          gap: 8px;
          padding: 24px 16px;
          border-radius: 16px;
          background-color: #fff;
          border: 1px solid var(--line);
          text-decoration: none;
        }
        @media (max-width: 960px) {
          .featuresGrid {
            grid-template-columns: repeat(2, minmax(0, 1fr));
          }
          .toolsGrid {
            grid-template-columns: repeat(3, minmax(0, 1fr));
          }
          .pipelineArrow {
            display: none;
          }
          .pipelineRail {
            gap: 24px;
          }
        }
        @media (max-width: 860px) {
          .homepageShell {
            padding: 12px 0 36px !important;
            gap: 16px !important;
          }
          .customHero {
            padding: 28px 20px 40px !important;
            gap: 32px !important;
            display: flex !important;
            flex-direction: column !important;
            align-items: center !important;
          }
          .customHeroTitle {
            font-size: 36px !important;
          }
          .customHeroBody {
            font-size: 16px !important;
          }
          .sectionHeader {
            gap: 12px !important;
            width: min(100%, 420px) !important;
            padding: 0 12px !important;
          }
          .sectionTitle {
            font-size: 24px !important;
            line-height: 1.08 !important;
          }
          .sectionIntro {
            font-size: 15px !important;
            line-height: 1.65 !important;
            max-width: 420px !important;
            padding: 0 10px !important;
          }
          .customHeroCopy {
            justify-items: center !important;
            text-align: center !important;
            width: 100% !important;
          }
          .customHeroActions {
            flex-direction: column;
            width: 100%;
          }
          .customHeroActions a {
            width: 100%;
            text-align: center;
            justify-content: center;
          }
          .homepageTopbar {
            flex-direction: row !important;
            align-items: center !important;
            justify-content: center !important;
            gap: 16px;
            padding: 16px 20px !important;
          }
          .homepageHeroPanel {
            display: grid !important;
            order: -1 !important;
            width: 100% !important;
            max-width: 360px !important;
            padding: 0 !important;
            gap: 10px !important;
            background: transparent !important;
            border: none !important;
            box-shadow: none !important;
          }
          .homepageHeroPanelHeader {
            justify-content: center !important;
            gap: 10px !important;
          }
          .homepageHeroList {
            gap: 10px !important;
          }
          .homepageHeroItem {
            padding: 12px !important;
            gap: 12px !important;
            border-radius: 14px !important;
          }
          .homepageHeroItem:nth-child(3) {
            display: none !important;
          }
          .homepageHeroItem > div:first-child {
            width: 44px !important;
            height: 44px !important;
          }
          .homepageHeroItem strong {
            font-size: 13px !important;
          }
          .homepageHeroItem p,
          .homepageHeroItem span {
            font-size: 10px !important;
          }
          .pipelineSection {
            padding: 36px 0 44px !important;
            gap: 18px !important;
          }
          .pipelineRail {
            justify-content: flex-start !important;
            overflow-x: auto !important;
            scroll-snap-type: x mandatory !important;
            -webkit-overflow-scrolling: touch !important;
            width: 100vw !important;
            margin-left: calc(50% - 50vw) !important;
            margin-right: calc(50% - 50vw) !important;
            padding: 4px 16px 8px !important;
            gap: 12px !important;
          }
          .pipelineStep {
            min-width: min(280px, calc(100vw - 72px)) !important;
            scroll-snap-align: start !important;
            padding: 0 !important;
            gap: 14px !important;
          }
          .pipelineStepNumber {
            font-size: 32px !important;
          }
          .pipelineStepTitle {
            font-size: 16px !important;
          }
          .pipelineStepBody {
            font-size: 13px !important;
            line-height: 1.55 !important;
          }
          .pipelineArrow {
            display: flex !important;
            min-width: 22px !important;
          }
          .quickstartSection {
            width: calc(100% - 16px) !important;
            padding: 40px 20px !important;
            margin-left: auto !important;
            margin-right: auto !important;
            border-radius: 16px !important;
            gap: 28px !important;
          }
          .quickstartGrid {
            grid-template-columns: 1fr !important;
            gap: 14px !important;
          }
          .quickstartCard {
            padding: 20px !important;
            gap: 14px !important;
          }
          .quickstartCardTitle {
            font-size: 18px !important;
          }
          .commandCode {
            font-size: 13px !important;
            padding: 11px 12px !important;
          }
          .commandField {
            width: 100% !important;
          }
          .copyButton {
            width: 26px !important;
            min-width: 26px !important;
            right: 6px !important;
          }
          .featuresSection,
          .toolsSection {
            width: calc(100% - 16px) !important;
            margin-left: auto !important;
            margin-right: auto !important;
            padding: 36px 0 !important;
            gap: 28px !important;
          }
          .featuresGrid {
            display: grid !important;
            grid-template-columns: 1fr !important;
            width: 100% !important;
            margin: 0 !important;
            padding: 0 !important;
            gap: 12px !important;
          }
          .featureCard {
            min-width: 0 !important;
            width: 100% !important;
            padding: 20px 18px !important;
            border-radius: 16px !important;
            gap: 14px !important;
          }
          .toolsGrid {
            display: flex !important;
            overflow-x: auto !important;
            scroll-snap-type: x mandatory !important;
            -webkit-overflow-scrolling: touch !important;
            width: 100vw !important;
            margin-left: calc(50% - 50vw) !important;
            margin-right: calc(50% - 50vw) !important;
            padding: 0 16px 8px !important;
            gap: 12px !important;
          }
          .featureCard,
          .toolCard {
            scroll-snap-align: start !important;
            flex-shrink: 0 !important;
          }
          .toolCard {
            min-width: 132px !important;
            padding: 20px 14px !important;
          }
        }
        @media (max-width: 560px) {
          .customHeroTitle {
            font-size: 30px !important;
          }
          .pipelineStep {
            min-width: calc(100vw - 64px) !important;
          }
        }
        .pipelineRail::-webkit-scrollbar,
        .featuresGrid::-webkit-scrollbar,
        .toolsGrid::-webkit-scrollbar {
          display: none;
        }
        .pipelineRail,
        .featuresGrid,
        .toolsGrid {
          scrollbar-width: none;
        }
      `
        }}
      />

      <header
        className="homepageTopbar"
        style={{
          ...contentWidthStyle,
          background: "var(--surface-soft)",
          border: "none",
          padding: "16px 24px",
          borderRadius: "16px",
          justifyContent: "center"
        }}
      >
        <div className="brandLockup">
          <div>
            <strong style={{ fontSize: "32px", fontFamily: "var(--font-display)", fontWeight: 800 }}>
              Prodx
            </strong>
          </div>
        </div>
      </header>

      <motion.section
        className="homepageHero customHero"
        style={contentWidthStyle}
        initial={{ opacity: 0, y: 20 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.6 }}
      >
        <div className="homepageHeroCopy customHeroCopy">
          <h1 className="customHeroTitle">Clean Shopify catalogs in minutes, not hours</h1>
          <p className="heroBody customHeroBody">
            Stop spending hours collecting, fixing, and formatting product data just to get it live.
            Prodx turns raw inputs, CSV files, text, or product images, into structured, QA-ready
            products you can publish with confidence.
          </p>
          <div className="heroActions customHeroActions" style={{ display: "flex", flexWrap: "wrap" }}>
            <a className="button isPrimary customPrimaryBtn" href="#quickstart">
              Download and run it
            </a>
            <a
              className="customSecondaryBtn"
              href="https://github.com/BlyzrHQ/prodx"
              target="_blank"
              rel="noopener noreferrer"
            >
              GitHub
            </a>
          </div>
        </div>

        <div
          className="homepageHeroPanel"
          style={{
            backgroundColor: "#fff",
            borderRadius: "16px",
            padding: "24px",
            gap: "16px",
            boxShadow: "0 1px 2px rgba(0,0,0,0.04)"
          }}
        >
          <div
            className="homepageHeroPanelHeader"
            style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}
          >
            <span
              style={{
                fontFamily: "var(--font-display)",
                fontSize: "14px",
                fontWeight: 600,
                color: "var(--ink)"
              }}
            >
              Product Catalog
            </span>
            <span
              style={{
                backgroundColor: "var(--primary-soft)",
                color: "var(--primary)",
                padding: "4px 10px",
                borderRadius: "9999px",
                fontFamily: "var(--font-body)",
                fontSize: "12px",
                fontWeight: 500
              }}
            >
              502 items
            </span>
          </div>
          <div className="homepageHeroList" style={{ gap: "16px" }}>
            {[
              {
                icon: Package,
                name: "Almarai Fresh Milk",
                sku: "ALM-MILK-1L",
                status: "Approved",
                bg: "#d1fae5",
                fg: "#059669"
              },
              {
                icon: ShoppingBag,
                name: "Cedar Grape Leaves",
                sku: "CEDAR-GL-908G",
                status: "Enriched",
                bg: "#dbeafe",
                fg: "#2563eb"
              },
              {
                icon: Package,
                name: "Organic Quinoa 500g",
                sku: "NEW",
                status: "In Review",
                bg: "#fef3c7",
                fg: "#d97706"
              }
            ].map((item) => (
              <div
                key={item.name}
                className="homepageHeroItem"
                style={{
                  backgroundColor: "var(--surface-soft)",
                  borderRadius: "12px",
                  padding: "16px",
                  gap: "16px"
                }}
              >
                <div
                  className="heroPreviewIcon"
                  style={{
                    backgroundColor: "var(--primary-soft)",
                    color: "var(--primary)",
                    width: "56px",
                    height: "56px",
                    borderRadius: "8px",
                    flexShrink: 0
                  }}
                >
                  <item.icon size={24} />
                </div>
                <div style={{ flex: 1, display: "flex", flexDirection: "column", gap: "4px" }}>
                  <strong
                    style={{
                      fontFamily: "var(--font-body)",
                      fontSize: "14px",
                      fontWeight: 500,
                      color: "var(--ink)"
                    }}
                  >
                    {item.name}
                  </strong>
                  <p
                    style={{
                      fontFamily: "var(--font-mono)",
                      fontSize: "11px",
                      fontWeight: "normal",
                      color: "var(--muted)",
                      margin: 0
                    }}
                  >
                    SKU: {item.sku}
                  </p>
                </div>
                <span
                  style={{
                    backgroundColor: item.bg,
                    color: item.fg,
                    padding: "4px 10px",
                    borderRadius: "9999px",
                    fontFamily: "var(--font-body)",
                    fontSize: "11px",
                    fontWeight: 600
                  }}
                >
                  {item.status}
                </span>
              </div>
            ))}
          </div>
        </div>
      </motion.section>

      <div
        style={{
          width: "100vw",
          position: "relative",
          left: "50%",
          right: "50%",
          marginLeft: "-50vw",
          marginRight: "-50vw",
          overflow: "hidden",
          background: "var(--primary)",
          padding: "18px 0",
          display: "flex",
          whiteSpace: "nowrap"
        }}
      >
        <motion.div
          animate={{ x: [0, -1200] }}
          transition={{ repeat: Infinity, ease: "linear", duration: 25 }}
          style={{ display: "flex", gap: "40px" }}
        >
          {Array.from({ length: 8 }, (_, repeatIndex) =>
            tickerMessages.map((text, messageIndex) => (
              <span
                key={`${repeatIndex}-${messageIndex}`}
                style={{ display: "inline-flex", alignItems: "center", gap: "18px" }}
              >
                <span
                  style={{
                    fontFamily: "var(--font-mono)",
                    fontSize: "18px",
                    fontWeight: 700,
                    color: "rgba(255,255,255,0.92)",
                    textTransform: "uppercase",
                    letterSpacing: "0.05em"
                  }}
                >
                  {text}
                </span>
                <span
                  aria-hidden="true"
                  style={{
                    width: "9px",
                    height: "9px",
                    borderRadius: "9999px",
                    border: "1.5px solid rgba(255,255,255,0.72)",
                    background: "transparent",
                    display: "inline-block"
                  }}
                />
              </span>
            ))
          )}
        </motion.div>
      </div>

      <motion.section
        className="pipelineSection"
        initial={{ opacity: 0, y: 20 }}
        whileInView={{ opacity: 1, y: 0 }}
        viewport={{ once: true, margin: "-100px" }}
        transition={{ duration: 0.6 }}
      >
        <div className="sectionHeader" style={sectionHeaderStyle}>
          <span style={sectionBadgeStyle}>Workflow</span>
          <h2 className="sectionTitle" style={{ ...sectionTitleStyle, lineHeight: 1.08 }}>
            How it works
          </h2>
        </div>
        <p
          className="sectionIntro"
          style={{
            ...sectionIntroStyle,
            maxWidth: "640px",
            textAlign: "center"
          }}
        >
          Every product moves through one clear flow before publishing, from intake and matching to
          enrichment, QA, and final approval.
        </p>
        <div className="pipelineRail">
          {pipelineSteps.map((step, index) => (
            <div key={step.title} style={{ display: "contents" }}>
              <div className="pipelineStep">
                <div className="pipelineStepNumber">0{index + 1}</div>
                <h3
                  className="pipelineStepTitle"
                  style={{
                    fontFamily: "var(--font-display)",
                    fontSize: "18px",
                    fontWeight: 600,
                    color: "var(--ink)",
                    margin: 0
                  }}
                >
                  {step.title}
                </h3>
                <p
                  className="pipelineStepBody"
                  style={{
                    fontFamily: "var(--font-body)",
                    fontSize: "14px",
                    lineHeight: 1.6,
                    color: "var(--secondary)",
                    margin: 0
                  }}
                >
                  {step.desc}
                </p>
              </div>
              {index < pipelineSteps.length - 1 ? (
                <div className="pipelineArrow" aria-hidden="true">
                  <ArrowRight size={28} />
                </div>
              ) : null}
            </div>
          ))}
        </div>
      </motion.section>

      <motion.section
        id="quickstart"
        className="quickstartSection"
        initial={{ opacity: 0, y: 20 }}
        whileInView={{ opacity: 1, y: 0 }}
        viewport={{ once: true, margin: "-100px" }}
        transition={{ duration: 0.6 }}
      >
        <div className="sectionHeader quickstartHeader" style={sectionHeaderStyle}>
          <span style={sectionBadgeStyle}>Quick start</span>
          <h2
            className="sectionTitle quickstartTitle"
            style={{ ...sectionTitleStyle, color: "#fff", width: "100%", maxWidth: "100%", lineHeight: 1.08 }}
          >
            Download and run locally
          </h2>
          <p className="sectionIntro" style={{ ...sectionIntroStyle, color: "#9CA89C", maxWidth: "600px" }}>
            Clone the repo, run setup, sync your store, and use the CLI to push products through the
            current review and publishing flow.
          </p>
        </div>
        <div className="quickstartGrid">
          <article className="quickstartCard">
            <div style={{ display: "flex", alignItems: "center", gap: "10px", color: "#fff" }}>
              <div
                style={{
                  width: "40px",
                  height: "40px",
                  backgroundColor: "rgba(255,255,255,0.1)",
                  borderRadius: "12px",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center"
                }}
              >
                <Download size={20} color="#fff" />
              </div>
              <strong className="quickstartCardTitle">Install &amp; Setup</strong>
            </div>
            <div className="commandList">
              {quickStart.map((command) => (
                <div key={command} className="commandField">
                  <code className="commandCode">{command}</code>
                  <button
                    type="button"
                    className="copyButton"
                    aria-label={`Copy command: ${command}`}
                    onClick={() => void handleCopy(command)}
                  >
                    {copiedCommand === command ? <Check size={16} /> : <Copy size={16} />}
                  </button>
                </div>
              ))}
            </div>
          </article>
          <article className="quickstartCard">
            <div style={{ display: "flex", alignItems: "center", gap: "10px", color: "#fff" }}>
              <div
                style={{
                  width: "40px",
                  height: "40px",
                  backgroundColor: "rgba(255,255,255,0.1)",
                  borderRadius: "12px",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center"
                }}
              >
                <TerminalSquare size={20} color="#fff" />
              </div>
              <strong className="quickstartCardTitle">Use the CLI</strong>
            </div>
            <div className="commandList">
              {exampleCommands.map((command) => (
                <div key={command} className="commandField">
                  <code className="commandCode">{command}</code>
                  <button
                    type="button"
                    className="copyButton"
                    aria-label={`Copy command: ${command}`}
                    onClick={() => void handleCopy(command)}
                  >
                    {copiedCommand === command ? <Check size={16} /> : <Copy size={16} />}
                  </button>
                </div>
              ))}
            </div>
          </article>
        </div>
      </motion.section>

      <motion.section
        className="featuresSection"
        initial={{ opacity: 0, y: 20 }}
        whileInView={{ opacity: 1, y: 0 }}
        viewport={{ once: true, margin: "-100px" }}
        transition={{ duration: 0.6 }}
      >
        <div className="sectionHeader" style={sectionHeaderStyle}>
          <span style={sectionBadgeStyle}>Features</span>
          <h2 className="sectionTitle" style={{ ...sectionTitleStyle, lineHeight: 1.08 }}>
            Everything you need
          </h2>
        </div>
        <div className="featuresGrid">
          {features.map((feature) => (
            <article key={feature.title} className="featureCard">
              <div
                style={{
                  width: "48px",
                  height: "48px",
                  borderRadius: "999px",
                  backgroundColor: "var(--primary-soft)",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  color: "var(--primary)"
                }}
              >
                <feature.icon size={24} />
              </div>
              <strong style={{ fontSize: "18px", fontWeight: 600, color: "var(--ink)" }}>
                {feature.title}
              </strong>
              <p style={{ fontSize: "14px", lineHeight: 1.6, color: "var(--secondary)", margin: 0 }}>
                {feature.body}
              </p>
            </article>
          ))}
        </div>
      </motion.section>

      <motion.section
        className="toolsSection"
        initial={{ opacity: 0, y: 20 }}
        whileInView={{ opacity: 1, y: 0 }}
        viewport={{ once: true, margin: "-100px" }}
        transition={{ duration: 0.6 }}
      >
        <div className="sectionHeader" style={sectionHeaderStyle}>
          <span style={sectionBadgeStyle}>Built with</span>
          <h2 className="sectionTitle" style={{ ...sectionTitleStyle, lineHeight: 1.08 }}>
            The current stack
          </h2>
        </div>
        <div className="toolsGrid">
          {tools.map((tool) => (
            <a
              key={tool.name}
              href={tool.url}
              target="_blank"
              rel="noopener noreferrer"
              className="toolCard"
            >
              <strong
                style={{
                  fontFamily: "var(--font-display)",
                  fontSize: "14px",
                  fontWeight: 600,
                  color: "var(--ink)"
                }}
              >
                {tool.name}
              </strong>
              <span
                style={{
                  fontFamily: "var(--font-body)",
                  fontSize: "11px",
                  color: "var(--secondary)",
                  textAlign: "center"
                }}
              >
                {tool.role}
              </span>
            </a>
          ))}
        </div>
      </motion.section>

      <footer
        style={{
          ...contentWidthStyle,
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          padding: "32px 20px 24px",
          gap: "12px",
          borderTop: "1px solid var(--line)",
          marginTop: "24px"
        }}
      >
        <strong style={{ fontSize: "24px", fontFamily: "var(--font-display)", fontWeight: 800, color: "var(--ink)" }}>
          Prodx
        </strong>
        <p
          style={{
            fontSize: "14px",
            color: "var(--secondary)",
            fontFamily: "var(--font-body)",
            margin: 0,
            textAlign: "center"
          }}
        >
          Open-source Shopify catalog management. Built by{" "}
          <a href="https://github.com/BlyzrHQ" style={{ color: "var(--primary)", textDecoration: "none" }}>
            BlyzrHQ
          </a>
        </p>
      </footer>
    </main>
  );
}
