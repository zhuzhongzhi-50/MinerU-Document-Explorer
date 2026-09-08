/**
 * Python script integration for QMD.
 * Spawns python3 processes for document extraction and returns typed results.
 */

import { spawn } from "child_process";
import { join } from "path";
import { fileURLToPath } from "url";
import {
  parsePythonResult,
  getPythonError,
  PdfExtractionResultSchema,
  DocxExtractionResultSchema,
  PptxExtractionResultSchema,
  PageIndexResultSchema,
  type PdfExtractionResult,
  type DocxExtractionResult,
  type PptxExtractionResult,
  type PageIndexResult,
} from "./python-types.js";

const __dirname = fileURLToPath(new URL(".", import.meta.url));

/**
 * Resolve the Python interpreter used to run the extraction scripts.
 *
 * Order: QMD_PYTHON env var > platform default (`python` on Windows, `python3` elsewhere).
 * QMD_PYTHON exists because Windows rarely ships a `python3` executable, and the
 * interpreter found on PATH may predate the required 3.10.
 */
let cachedPythonCommand: string | null = null;

function resolvePythonCommand(): string {
  if (cachedPythonCommand) return cachedPythonCommand;
  const fromEnv = process.env.QMD_PYTHON?.trim();
  cachedPythonCommand = fromEnv || (process.platform === "win32" ? "python" : "python3");
  return cachedPythonCommand;
}

/** Reset the cached interpreter (used when QMD_PYTHON changes at runtime). */
export function resetPythonCommandCache(): void {
  cachedPythonCommand = null;
}

const MAX_BUFFER = 100 * 1024 * 1024; // 100 MiB

/**
 * Call a Python script and parse the JSON output.
 * Throws if the script fails or returns invalid JSON.
 *
 * @param scriptName - Name of the Python script in backends/python/
 * @param args - Command line arguments to pass to the script
 * @param env - Additional environment variables
 * @returns The parsed JSON output
 */
export function callPythonScript(
  scriptName: string,
  args: string[],
  env?: Record<string, string>
): Promise<unknown> {
  const scriptPath = join(__dirname, "python", scriptName);
  const pythonCommand = resolvePythonCommand();
  return new Promise((resolve, reject) => {
    const child = spawn(pythonCommand, [scriptPath, ...args], {
      env: env ? { ...process.env, ...env } : undefined,
      stdio: ["ignore", "pipe", "pipe"],
    });

    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let stdoutLen = 0;
    let stderrLen = 0;
    let killed = false;

    child.stdout.on("data", (chunk: Buffer) => {
      stdoutLen += chunk.length;
      if (stdoutLen > MAX_BUFFER) {
        if (!killed) { killed = true; child.kill(); }
        return;
      }
      stdoutChunks.push(chunk);
    });

    child.stderr.on("data", (chunk: Buffer) => {
      stderrLen += chunk.length;
      if (stderrLen > MAX_BUFFER) {
        if (!killed) { killed = true; child.kill(); }
        return;
      }
      stderrChunks.push(chunk);
    });

    child.on("error", (err) => {
      reject(new Error(
        `Failed to spawn Python interpreter "${pythonCommand}": ${err.message}\n` +
        `Set QMD_PYTHON to a Python 3.10+ executable if it is not on PATH.`
      ));
    });

    child.on("close", (code) => {
      if (killed) {
        reject(new Error(`Python script ${scriptName} exceeded ${MAX_BUFFER} byte output limit`));
        return;
      }
      const stdout = Buffer.concat(stdoutChunks).toString("utf-8");
      const stderr = Buffer.concat(stderrChunks).toString("utf-8");
      if (code !== 0) {
        reject(new Error(`Python script ${scriptName} failed:\n${stderr}`));
        return;
      }
      try {
        resolve(JSON.parse(stdout));
      } catch {
        reject(new Error(`Python script ${scriptName} returned invalid JSON:\n${stdout.slice(0, 200)}`));
      }
    });
  });
}

/**
 * Call extract_pdf.py and return typed PDF extraction result.
 */
export async function extractPdf(filepath: string): Promise<PdfExtractionResult> {
  const data = await callPythonScript("extract_pdf.py", [filepath]);
  return parsePythonResult(data, PdfExtractionResultSchema, "extract_pdf.py");
}

/**
 * Call extract_pdf_pageindex.py and return typed PageIndex result.
 */
export async function extractPdfPageindex(
  filepath: string,
  baseUrl: string,
  model: string
): Promise<PageIndexResult> {
  const data = await callPythonScript("extract_pdf_pageindex.py", [filepath, baseUrl, model]);
  return parsePythonResult(data, PageIndexResultSchema, "extract_pdf_pageindex.py");
}

/**
 * Call extract_docx.py and return typed Docx extraction result.
 */
export async function extractDocx(filepath: string): Promise<DocxExtractionResult> {
  const data = await callPythonScript("extract_docx.py", [filepath]);
  return parsePythonResult(data, DocxExtractionResultSchema, "extract_docx.py");
}

/**
 * Call extract_docx.py for table extraction only.
 */
export async function extractDocxTables(filepath: string): Promise<DocxExtractionResult> {
  const data = await callPythonScript("extract_docx.py", [filepath, "--tables-only"]);
  return parsePythonResult(data, DocxExtractionResultSchema, "extract_docx.py");
}

/**
 * Call extract_pptx.py and return typed PPTX extraction result.
 */
export async function extractPptx(filepath: string): Promise<PptxExtractionResult> {
  const data = await callPythonScript("extract_pptx.py", [filepath]);
  return parsePythonResult(data, PptxExtractionResultSchema, "extract_pptx.py");
}

/**
 * Call extract_pptx.py for table extraction only.
 */
export async function extractPptxTables(filepath: string): Promise<PptxExtractionResult> {
  const data = await callPythonScript("extract_pptx.py", [filepath, "--tables-only"]);
  return parsePythonResult(data, PptxExtractionResultSchema, "extract_pptx.py");
}

/**
 * Check if a Python script result contains an error.
 * Returns the error message or null.
 */
export { getPythonError };
