"use client";

import { useEffect, useMemo, useState } from "react";
import type { ExportFormat, PartRecord, PinRecord } from "../lib/types";
// Type-only import: erased at compile time, so no retrieval-layer runtime code (node:crypto,
// the resolvers, etc.) is pulled into the client bundle.
import type { DeploymentMode } from "../lib/retrieval";

interface AppConfig {
  mode: DeploymentMode;
  lookupEnabled: boolean;
}

const formatOptions: Array<{ value: ExportFormat; label: string; note: string }> = [
  { value: "kicad", label: "KiCad source", note: "Native .kicad_sym + .kicad_mod" },
  { value: "altium", label: "Altium bundle", note: "Vendor-neutral exchange source, not native SchLib/PcbLib yet" },
  { value: "cadence", label: "Cadence / OrCAD bundle", note: "Vendor-neutral exchange source, not native library files yet" }
]

const defaultPart: PartRecord = {
  id: "",
  partNumber: "",
  manufacturer: "",
  packageType: "",
  pinCount: 0,
  pins: [],
  dimensions: {
    bodyLengthMm: null,
    bodyWidthMm: null,
    bodyHeightMm: null,
    pitchMm: null,
    leadLengthMm: null,
    leadCount: null
  },
  radiation: {
    tid: null,
    see: null,
    sel: null,
    qmlClass: null
  },
  sourceFileName: "",
  notes: []
};

function clonePart(part: PartRecord): PartRecord {
  return JSON.parse(JSON.stringify(part)) as PartRecord;
}

function updatePin(part: PartRecord, index: number, field: keyof PinRecord, value: string) {
  const next = clonePart(part);
  const pin = next.pins[index];
  if (!pin) return next;

  if (field === "electricalType") {
    pin.electricalType = value as PinRecord["electricalType"];
  } else if (field === "number" || field === "name") {
    pin[field] = value;
  }

  return next;
}

function formatSourceUrl(sourceUrl?: string) {
  if (!sourceUrl) {
    return null;
  }

  try {
    return new URL(sourceUrl);
  } catch {
    return null;
  }
}

export default function HomePage() {
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [partPrompt, setPartPrompt] = useState("");
  const [manufacturerHint, setManufacturerHint] = useState("");
  const [part, setPart] = useState<PartRecord>(defaultPart);
  const [selectedFormat, setSelectedFormat] = useState<ExportFormat>("kicad");
  const [status, setStatus] = useState("Loading workspace...");
  const [busy, setBusy] = useState(false);

  // Deployment mode surfaced by GET /api/config. Stays null while loading so the lookup box
  // never flashes on screen before we know whether it is allowed. The server 403 on
  // /api/lookup remains the real gate; this only decides which UI to render.
  const [config, setConfig] = useState<AppConfig | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/config")
      .then((res) => res.json())
      .then((data: AppConfig) => {
        if (cancelled) return;
        setConfig(data);
        setStatus(
          data.lookupEnabled
            ? "Enter a part number, or upload a datasheet PDF."
            : "Air-gapped mode: upload a datasheet PDF to begin."
        );
      })
      .catch(() => {
        if (cancelled) return;
        // Config is UX only and the server gate still holds, but fail closed here to match the
        // server's production default: if the mode cannot be confirmed, assume no network and
        // show upload only rather than offering a lookup that would just 403.
        setConfig({ mode: "air-gapped", lookupEnabled: false });
        setStatus("Could not confirm deployment mode. Upload a datasheet PDF to begin.");
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const dimensionsRows = useMemo(
    () => [
      ["Body length", part.dimensions.bodyLengthMm],
      ["Body width", part.dimensions.bodyWidthMm],
      ["Body height", part.dimensions.bodyHeightMm],
      ["Pitch", part.dimensions.pitchMm],
      ["Lead length", part.dimensions.leadLengthMm],
      ["Lead count", part.dimensions.leadCount]
    ],
    [part.dimensions]
  );

  const sourceUrl = formatSourceUrl(part.sourceUrl);

  async function handleLookup() {
    const trimmedPart = partPrompt.trim();
    if (!trimmedPart) {
      setStatus("Enter a part number first.");
      return;
    }

    setBusy(true);
    setStatus(`Resolving the datasheet for ${trimmedPart}...`);

    try {
      const response = await fetch("/api/lookup", {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          partNumber: trimmedPart,
          manufacturer: manufacturerHint.trim()
        })
      });

      const payload = await response.json();
      if (!response.ok) {
        throw new Error(payload.error || "Failed to find the datasheet.");
      }

      setPart(payload.part as PartRecord);
      setSelectedFile(null);
      setStatus(`Found the datasheet PDF for ${trimmedPart}. Review the record before export.`);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Unexpected lookup failure.");
      setPart(defaultPart);
    } finally {
      setBusy(false);
    }
  }

  async function handlePromptSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    await handleLookup();
  }

  async function handleFile(file: File | null) {
    setSelectedFile(file);
    if (!file) return;

    setBusy(true);
    setStatus(`Parsing ${file.name}...`);

    try {
      const formData = new FormData();
      formData.append("file", file);

      const response = await fetch("/api/parse", { method: "POST", body: formData });
      const payload = await response.json();

      if (!response.ok) {
        throw new Error(payload.error || "Failed to parse datasheet.");
      }

      setPart(payload.part as PartRecord);
      setStatus(`Parsed ${payload.part.partNumber}. Review fields before export.`);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Unexpected parse failure.");
      setPart(defaultPart);
    } finally {
      setBusy(false);
    }
  }

  async function handleExport() {
    setBusy(true);
    setStatus(`Building ${selectedFormat.toUpperCase()} export bundle...`);

    try {
      const response = await fetch("/api/export", {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify({ part, format: selectedFormat })
      });

      if (!response.ok) {
        const payload = await response.json().catch(() => null);
        throw new Error(payload?.error || "Export failed.");
      }

      const blob = await response.blob();
      const objectUrl = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = objectUrl;
      anchor.download = `${part.partNumber || "forge-part"}-forge.zip`;
      anchor.click();
      URL.revokeObjectURL(objectUrl);

      const stepSupported = response.headers.get("X-Forge-Step-Supported") === "true";
      const stepNote = response.headers.get("X-Forge-Step-Note") || "";
      const exportNote = response.headers.get("X-Forge-Export-Note") || "";
      setStatus(stepSupported ? `ZIP downloaded. ${exportNote}`.trim() : `ZIP downloaded. ${stepNote || exportNote}`.trim());
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Unexpected export failure.");
    } finally {
      setBusy(false);
    }
  }

  const jsonPreview = JSON.stringify(part, null, 2);

  // Upload is the enterprise/air-gapped path and is available in every mode, so it is shared
  // between the commercial layout (as the fallback) and the air-gapped layout (as the only path).
  const uploadCard = (
    <label className="upload-card" htmlFor="datasheet-upload">
      <div className="upload-title">{config?.lookupEnabled ? "Fallback: upload a PDF" : "Upload a datasheet PDF"}</div>
      <div className="upload-body">
        {config?.lookupEnabled
          ? "Drop a local datasheet here if you already have the file."
          : "Datasheets are read locally and never leave your network."}
      </div>
      <input
        id="datasheet-upload"
        type="file"
        accept="application/pdf"
        onChange={(event) => handleFile(event.target.files?.[0] ?? null)}
      />
      <div className="file-name">{selectedFile ? selectedFile.name : "No file selected"}</div>
    </label>
  );

  return (
    <main className="workspace-shell">
      <header className="topbar">
        <div>
          <div className="eyebrow">Forge</div>
          <h1>Vertical datasheet AI for CAD teams</h1>
          <p className="hero-copy">
            {config === null
              ? "Forge turns rad-hard datasheets into download-ready CAD bundles."
              : config.lookupEnabled
                ? "Give Forge a part number. It resolves the datasheet, parses the PDF, and generates a download-ready CAD bundle."
                : "Upload a rad-hard datasheet PDF. Forge parses it locally and generates a download-ready CAD bundle, with no data leaving your network."}
          </p>
        </div>
        <div className="status-box">{status}</div>
      </header>

      <section className="tool-row">
        {config === null ? (
          <div className="panel config-loading" aria-busy="true">
            Loading workspace...
          </div>
        ) : config.lookupEnabled ? (
          <>
            <article className="prompt-card panel">
              <div className="card-kicker">AI intake</div>
              <h2>What part are you working on?</h2>
              <p>Enter a manufacturer part number. Forge resolves the datasheet, ingests it, and prefills the normalized part record.</p>

              <form className="chat-shell" onSubmit={handlePromptSubmit}>
                <div className="chat-thread">
                  <div className="chat-bubble assistant">
                    Start with a part number. You can add a manufacturer hint if the name is ambiguous.
                  </div>
                </div>

                <div className="chat-input-row">
                  <label>
                    <span>Part number</span>
                    <input value={partPrompt} onChange={(event) => setPartPrompt(event.target.value)} placeholder="Type a part number" />
                  </label>
                  <label>
                    <span>Manufacturer hint</span>
                    <input value={manufacturerHint} onChange={(event) => setManufacturerHint(event.target.value)} placeholder="Optional" />
                  </label>
                  <button className="primary-button" type="submit" disabled={busy}>
                    Find datasheet & parse
                  </button>
                </div>
              </form>

              <div className="prompt-footnote">Resolves through the component API first. PDF upload remains the fallback.</div>

              {sourceUrl ? (
                <div className="source-banner">
                  <span>Source</span>
                  <a href={sourceUrl.href} target="_blank" rel="noreferrer">
                    {sourceUrl.href}
                  </a>
                </div>
              ) : null}
            </article>

            {uploadCard}
          </>
        ) : (
          <>
            <article className="prompt-card panel airgap-notice">
              <div className="card-kicker">Air-gapped mode</div>
              <h2>Part-number lookup is disabled</h2>
              <p>
                This deployment runs with zero network egress, so Forge never reaches an external
                component API. Upload the datasheet PDF directly and it is processed entirely on
                your own infrastructure.
              </p>
            </article>

            {uploadCard}
          </>
        )}
      </section>

      <section className="tool-row export-row">
        <div className="format-card panel">
          <div className="card-title">Export destination</div>
          <div className="format-grid">
            {formatOptions.map((option) => (
              <button
                key={option.value}
                type="button"
                className={option.value === selectedFormat ? "format-button active" : "format-button"}
                onClick={() => setSelectedFormat(option.value)}
              >
                <span>{option.label}</span>
                <small>{option.note}</small>
              </button>
            ))}
          </div>
          <button className="export-button" type="button" onClick={handleExport} disabled={busy || !part.partNumber}>
            Download ZIP
          </button>
        </div>

        <div className="mini-panel panel">
          <div className="card-title">What Forge outputs</div>
          <ul className="capability-list">
            <li>Normalized part record with provenance.</li>
            <li>Symbol, footprint, and STEP source files.</li>
            <li>Vendor-neutral bundle for Altium and Cadence until native emitters land.</li>
          </ul>
        </div>
      </section>

      <section className="content-grid">
        <article className="panel">
          <div className="panel-title">Parsed part record</div>
          <div className="field-grid">
            <label>
              <span>Part number</span>
              <input value={part.partNumber} onChange={(event) => setPart({ ...part, partNumber: event.target.value })} />
            </label>
            <label>
              <span>Manufacturer</span>
              <input value={part.manufacturer} onChange={(event) => setPart({ ...part, manufacturer: event.target.value })} />
            </label>
            <label>
              <span>Package type</span>
              <input value={part.packageType} onChange={(event) => setPart({ ...part, packageType: event.target.value })} />
            </label>
            <label>
              <span>Pin count</span>
              <input
                type="number"
                value={part.pinCount}
                onChange={(event) => setPart({ ...part, pinCount: Number(event.target.value) || 0 })}
              />
            </label>
          </div>

          <div className="subpanel-title">Package dimensions</div>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Field</th>
                  <th>Value (mm)</th>
                </tr>
              </thead>
              <tbody>
                {dimensionsRows.map(([label, value]) => (
                  <tr key={label}>
                    <td>{label}</td>
                    <td>{value ?? "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="subpanel-title">Radiation data</div>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Field</th>
                  <th>Value</th>
                </tr>
              </thead>
              <tbody>
                <tr>
                  <td>TID</td>
                  <td>{part.radiation.tid ?? "—"}</td>
                </tr>
                <tr>
                  <td>SEE</td>
                  <td>{part.radiation.see ?? "—"}</td>
                </tr>
                <tr>
                  <td>SEL</td>
                  <td>{part.radiation.sel ?? "—"}</td>
                </tr>
                <tr>
                  <td>QML/QPL</td>
                  <td>{part.radiation.qmlClass ?? "—"}</td>
                </tr>
              </tbody>
            </table>
          </div>

          <div className="subpanel-title">Pin table</div>
          <div className="table-wrap pin-table">
            <table>
              <thead>
                <tr>
                  <th>#</th>
                  <th>Name</th>
                  <th>Type</th>
                  <th>Description</th>
                </tr>
              </thead>
              <tbody>
                {part.pins.map((pin, index) => (
                  <tr key={`${pin.number}-${index}`}>
                    <td>
                      <input value={pin.number} onChange={(event) => setPart(updatePin(part, index, "number", event.target.value))} />
                    </td>
                    <td>
                      <input value={pin.name} onChange={(event) => setPart(updatePin(part, index, "name", event.target.value))} />
                    </td>
                    <td>
                      <select
                        value={pin.electricalType}
                        onChange={(event) => setPart(updatePin(part, index, "electricalType", event.target.value))}
                      >
                        <option value="unspecified">unspecified</option>
                        <option value="power">power</option>
                        <option value="input">input</option>
                        <option value="output">output</option>
                        <option value="bidirectional">bidirectional</option>
                        <option value="passive">passive</option>
                        <option value="nc">nc</option>
                        <option value="open_collector">open_collector</option>
                        <option value="open_emitter">open_emitter</option>
                      </select>
                    </td>
                    <td>{pin.description ?? ""}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </article>

        <aside className="panel json-panel">
          <div className="panel-title">Normalized JSON</div>
          <textarea readOnly value={jsonPreview} />
          <div className="note-list">
            {part.notes.map((note) => (
              <div key={note}>{note}</div>
            ))}
          </div>
        </aside>
      </section>
    </main>
  );
}