import React, {
  useCallback,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type DragEvent as ReactDragEvent,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";

import { Button } from "@dynatrace/strato-components/buttons";
import { FormField, Label, Select, TextInput } from "@dynatrace/strato-components/forms";
import { Flex } from "@dynatrace/strato-components/layouts";
import {
  Heading,
  Paragraph,
  Text,
} from "@dynatrace/strato-components/typography";
import { MessageContainer } from "@dynatrace/strato-components/content";
import { DataTable } from "@dynatrace/strato-components-preview/tables";
import { DocumentIcon, UploadIcon } from "@dynatrace/strato-icons";

type CsvParseResult = {
  headers: string[];
  rows: string[][];
  uniqueFields: string[];
  rowCount: number;
  warnings: string[];
};

type PreviewRecord = Record<string, unknown>;

type UploadResult = {
  discardedDuplicates: number;
  fileSize: number;
  patternMatches: number;
  records: number;
  skippedRecords: number;
  uploadedBytes: number;
};

type TestPatternResponse = {
  numberOfRecords?: number;
  records?: Array<Record<string, unknown>>;
};

const LOOKUP_PATH_PREFIX = "/lookups/";

function stripBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

function detectLineEndingWarnings(text: string): string[] {
  const warnings: string[] = [];
  const crlf = (text.match(/\r\n/g) ?? []).length;
  const loneLf = (text.match(/(^|[^\r])\n/g) ?? []).length;
  const loneCr = (text.match(/\r(?!\n)/g) ?? []).length;
  const variants = [crlf, loneLf, loneCr].filter((n) => n > 0).length;
  if (variants > 1) {
    warnings.push(
      "Mixed line endings detected (CRLF, LF, or CR). The parser handles them, but this can indicate the file was edited on multiple platforms.",
    );
  }
  return warnings;
}

function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let current: string[] = [];
  let field = "";
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += ch;
      }
      continue;
    }
    if (ch === '"') {
      inQuotes = true;
    } else if (ch === ",") {
      current.push(field);
      field = "";
    } else if (ch === "\n") {
      current.push(field);
      rows.push(current);
      current = [];
      field = "";
    } else if (ch === "\r") {
      // ignore CR, handled by LF
    } else {
      field += ch;
    }
  }
  if (field.length > 0 || current.length > 0) {
    current.push(field);
    rows.push(current);
  }
  // Drop fully empty trailing rows
  while (rows.length > 0 && rows[rows.length - 1].every((c) => c.trim() === "")) {
    rows.pop();
  }
  return rows;
}

function validateCsv(grid: string[][]): {
  ok: boolean;
  error?: string;
  warnings: string[];
  headers: string[];
  rows: string[][];
} {
  const warnings: string[] = [];
  if (grid.length === 0) {
    return {
      ok: false,
      error: "The file is empty.",
      warnings,
      headers: [],
      rows: [],
    };
  }
  const headers = grid[0].map((h) => h.trim());
  if (headers.length < 2 || headers.some((h) => h === "")) {
    return {
      ok: false,
      error: "The header row must contain at least two non-empty column names.",
      warnings,
      headers,
      rows: [],
    };
  }
  const seen = new Map<string, number>();
  headers.forEach((h) => {
    const key = h.toLowerCase();
    seen.set(key, (seen.get(key) ?? 0) + 1);
  });
  const duplicates: string[] = [];
  seen.forEach((count, key) => {
    if (count > 1) duplicates.push(key);
  });
  if (duplicates.length > 0) {
    return {
      ok: false,
      error: `Duplicate column names in header: ${duplicates.join(", ")}.`,
      warnings,
      headers,
      rows: [],
    };
  }
  const rows = grid.slice(1);
  if (rows.length === 0) {
    return {
      ok: false,
      error: "No data rows found below the header.",
      warnings,
      headers,
      rows,
    };
  }
  const badRowIndex = rows.findIndex((r) => r.length !== headers.length);
  if (badRowIndex >= 0) {
    return {
      ok: false,
      error: `Row ${badRowIndex + 2} has ${rows[badRowIndex].length} columns, expected ${headers.length}.`,
      warnings,
      headers,
      rows,
    };
  }
  const emptyCellRows: number[] = [];
  rows.forEach((r, idx) => {
    if (r.some((c) => c.trim() === "")) emptyCellRows.push(idx + 2);
  });
  if (emptyCellRows.length > 0) {
    const preview = emptyCellRows.slice(0, 3).join(", ");
    const more = emptyCellRows.length > 3 ? ` (+${emptyCellRows.length - 3} more)` : "";
    warnings.push(
      `${emptyCellRows.length} row(s) contain empty cells. Example rows: ${preview}${more}.`,
    );
  }
  return { ok: true, warnings, headers, rows };
}

function findUniqueFields(headers: string[], rows: string[][]): string[] {
  const unique: string[] = [];
  headers.forEach((header, colIdx) => {
    const seen = new Set<string>();
    let isUnique = true;
    for (const row of rows) {
      const value = (row[colIdx] ?? "").trim();
      if (value === "" || seen.has(value)) {
        isUnique = false;
        break;
      }
      seen.add(value);
    }
    if (isUnique) unique.push(header);
  });
  return unique;
}

function buildParsePattern(headers: string[]): string {
  return headers.map((h) => `LD:${h}`).join(" ',' ");
}

function fileNameWithoutExtension(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.substring(0, dot) : name;
}

function sanitizeForPath(name: string): string {
  const cleaned = name.replace(/[^a-zA-Z0-9._-]/g, "_").replace(/_+/g, "_");
  return cleaned.replace(/^_+|_+$/g, "") || "lookup";
}

function flattenRecord(record: Record<string, unknown>): PreviewRecord {
  const out: PreviewRecord = {};
  for (const [key, value] of Object.entries(record)) {
    if (value && typeof value === "object" && !Array.isArray(value)) {
      const nested = value as Record<string, unknown>;
      if ("value" in nested && Object.keys(nested).length <= 2) {
        out[key] = nested.value;
        continue;
      }
    }
    out[key] = value;
  }
  return out;
}

function formatCellValue(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return JSON.stringify(value);
}

const RESOURCE_STORE_BASE = "/platform/storage/resource-store/v1/files/tabular";

type ErrorEnvelope = {
  error?: {
    message?: string;
    code?: number;
    errorDetails?: Array<{ message?: string }>;
  };
};

async function postMultipart<T>(
  endpoint: string,
  requestJson: Record<string, unknown>,
  content: Blob,
): Promise<T> {
  const formData = new FormData();
  formData.append("request", JSON.stringify(requestJson));
  formData.append("content", content);
  const response = await fetch(`${RESOURCE_STORE_BASE}/${endpoint}`, {
    method: "POST",
    body: formData,
  });
  const text = await response.text();
  let parsed: unknown = null;
  if (text) {
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = null;
    }
  }
  if (!response.ok) {
    const envelope = parsed as ErrorEnvelope | null;
    const envMessage = envelope?.error?.message;
    const details = envelope?.error?.errorDetails
      ?.map((d) => d.message)
      .filter(Boolean)
      .join(" | ");
    const combined =
      envMessage && details
        ? `${envMessage} (${details})`
        : envMessage ?? details ?? text ?? `HTTP ${response.status}`;
    throw new Error(combined);
  }
  return parsed as T;
}

function extractErrorMessage(err: unknown): string {
  if (!err) return "Unknown error.";
  const anyErr = err as {
    body?: { error?: { message?: string; errorDetails?: Array<{ message?: string }> } };
    message?: string;
  };
  const envMessage = anyErr.body?.error?.message;
  const details = anyErr.body?.error?.errorDetails
    ?.map((d) => d.message)
    .filter(Boolean)
    .join(" | ");
  if (envMessage && details) return `${envMessage} (${details})`;
  if (envMessage) return envMessage;
  if (details) return details;
  return anyErr.message ?? "Unexpected error.";
}

export const Home = () => {
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const [file, setFile] = useState<File | null>(null);
  const [fileContent, setFileContent] = useState<string>("");
  const [csvInfo, setCsvInfo] = useState<CsvParseResult | null>(null);
  const [csvError, setCsvError] = useState<string | null>(null);

  const [lookupField, setLookupField] = useState<string | null>(null);
  const [displayName, setDisplayName] = useState<string>("");

  const [isPreviewing, setIsPreviewing] = useState(false);
  const [previewData, setPreviewData] = useState<PreviewRecord[] | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [previewNumberOfRecords, setPreviewNumberOfRecords] = useState<number | null>(null);

  const [isUploading, setIsUploading] = useState(false);
  const [uploadResult, setUploadResult] = useState<UploadResult | null>(null);
  const [uploadError, setUploadError] = useState<string | null>(null);

  const resetPreviewState = useCallback(() => {
    setPreviewData(null);
    setPreviewError(null);
    setPreviewNumberOfRecords(null);
    setUploadResult(null);
    setUploadError(null);
  }, []);

  const handleReset = useCallback(() => {
    setFile(null);
    setFileContent("");
    setCsvInfo(null);
    setCsvError(null);
    setLookupField(null);
    setDisplayName("");
    setIsPreviewing(false);
    setIsUploading(false);
    resetPreviewState();
    if (fileInputRef.current) {
      fileInputRef.current.value = "";
    }
  }, [resetPreviewState]);

  const processFile = useCallback(
    async (selected: File | null) => {
      setFile(selected);
      setFileContent("");
      setCsvInfo(null);
      setCsvError(null);
      setLookupField(null);
      resetPreviewState();

      if (!selected) return;

      if (
        !selected.name.toLowerCase().endsWith(".csv") &&
        selected.type &&
        !selected.type.includes("csv") &&
        !selected.type.includes("text")
      ) {
        setCsvError("Please choose a .csv file.");
        return;
      }

      try {
        const rawText = await selected.text();
        const hadBom = rawText.charCodeAt(0) === 0xfeff;
        const text = stripBom(rawText);
        const lineEndingWarnings = detectLineEndingWarnings(text);
        const grid = parseCsv(text);
        const validation = validateCsv(grid);
        const warnings = [...lineEndingWarnings, ...validation.warnings];
        if (hadBom) {
          warnings.unshift("A UTF-8 BOM was detected at the start of the file and stripped before parsing.");
        }
        if (!validation.ok) {
          setCsvError(validation.error ?? "The CSV could not be parsed.");
          return;
        }
        const uniqueFields = findUniqueFields(validation.headers, validation.rows);
        if (uniqueFields.length === 0) {
          setCsvError(
            "No column has fully unique non-empty values. A lookup field is required.",
          );
          setCsvInfo({
            headers: validation.headers,
            rows: validation.rows,
            uniqueFields: [],
            rowCount: validation.rows.length,
            warnings,
          });
          setFileContent(text);
          return;
        }
        setCsvInfo({
          headers: validation.headers,
          rows: validation.rows,
          uniqueFields,
          rowCount: validation.rows.length,
          warnings,
        });
        setFileContent(text);
        setLookupField(uniqueFields[0] ?? null);
      } catch (err) {
        setCsvError(`Could not read file: ${extractErrorMessage(err)}`);
      }
    },
    [resetPreviewState],
  );

  const handleFileChange = useCallback(
    (event: ChangeEvent<HTMLInputElement>) => {
      const selected = event.target.files?.[0] ?? null;
      void processFile(selected);
    },
    [processFile],
  );

  const [isDragActive, setIsDragActive] = useState(false);

  const handleDragEnter = useCallback((event: ReactDragEvent<HTMLDivElement>) => {
    event.preventDefault();
    event.stopPropagation();
    setIsDragActive(true);
  }, []);

  const handleDragOver = useCallback((event: ReactDragEvent<HTMLDivElement>) => {
    event.preventDefault();
    event.stopPropagation();
    setIsDragActive(true);
  }, []);

  const handleDragLeave = useCallback((event: ReactDragEvent<HTMLDivElement>) => {
    event.preventDefault();
    event.stopPropagation();
    setIsDragActive(false);
  }, []);

  const handleDrop = useCallback(
    (event: ReactDragEvent<HTMLDivElement>) => {
      event.preventDefault();
      event.stopPropagation();
      setIsDragActive(false);
      const dropped = event.dataTransfer?.files?.[0] ?? null;
      void processFile(dropped);
    },
    [processFile],
  );

  const openFilePicker = useCallback(() => {
    fileInputRef.current?.click();
  }, []);

  const handleDropZoneKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLDivElement>) => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        openFilePicker();
      }
    },
    [openFilePicker],
  );

  const handleRemoveFile = useCallback(() => {
    if (fileInputRef.current) {
      fileInputRef.current.value = "";
    }
    void processFile(null);
  }, [processFile]);

  const parsePattern = useMemo(
    () => (csvInfo ? buildParsePattern(csvInfo.headers) : ""),
    [csvInfo],
  );

  const canPreview =
    !!file && !!csvInfo && !!lookupField && !isPreviewing && !csvError;

  const canUpload =
    canPreview && !!previewData && !previewError && !isUploading;

  const handlePreview = useCallback(async () => {
    if (!file || !csvInfo || !lookupField) return;
    setIsPreviewing(true);
    setPreviewError(null);
    setPreviewData(null);
    setPreviewNumberOfRecords(null);
    setUploadResult(null);
    setUploadError(null);
    try {
      const response = await postMultipart<TestPatternResponse>(
        "lookup:test-pattern",
        {
          lookupField,
          parsePattern,
          skippedRecords: 1,
        },
        new Blob([fileContent], { type: "text/csv" }),
      );
      const records = (response.records ?? []).map((r) => flattenRecord(r));
      setPreviewData(records);
      setPreviewNumberOfRecords(response.numberOfRecords ?? records.length);
    } catch (err) {
      setPreviewError(extractErrorMessage(err));
    } finally {
      setIsPreviewing(false);
    }
  }, [file, csvInfo, lookupField, fileContent, parsePattern]);

  const handleUpload = useCallback(async () => {
    if (!file || !csvInfo || !lookupField) return;
    setIsUploading(true);
    setUploadError(null);
    setUploadResult(null);
    try {
      const baseName = fileNameWithoutExtension(file.name);
      const filePath = `${LOOKUP_PATH_PREFIX}${sanitizeForPath(baseName)}`;
      const effectiveDisplayName = displayName.trim() || baseName;
      const response = await postMultipart<UploadResult>(
        "lookup:upload",
        {
          filePath,
          lookupField,
          parsePattern,
          skippedRecords: 1,
          displayName: effectiveDisplayName,
          overwrite: true,
        },
        new Blob([fileContent], { type: "text/csv" }),
      );
      setUploadResult(response);
    } catch (err) {
      setUploadError(extractErrorMessage(err));
    } finally {
      setIsUploading(false);
    }
  }, [file, csvInfo, lookupField, fileContent, parsePattern, displayName]);

  const previewColumns = useMemo(() => {
    if (!previewData || previewData.length === 0) return [];
    const keys = Object.keys(previewData[0]);
    return keys.map((key) => ({
      id: key,
      header: key,
      accessor: (row: PreviewRecord) => formatCellValue(row[key]),
    }));
  }, [previewData]);

  const previewRows = previewData ?? [];

  const targetFilePath = file
    ? `${LOOKUP_PATH_PREFIX}${sanitizeForPath(fileNameWithoutExtension(file.name))}`
    : null;

  const isFormDirty =
    !!file ||
    !!csvInfo ||
    !!csvError ||
    !!lookupField ||
    displayName.length > 0 ||
    !!previewData ||
    !!previewError ||
    !!uploadResult ||
    !!uploadError;

  return (
    <Flex flexDirection="column" gap={24} padding={32} maxWidth={960}>
      <Flex gap={16} alignItems="center">
        <img
          src="./assets/Dynatrace_Logo.svg"
          alt="Dynatrace Logo"
          width={64}
          height={64}
        />
        <Flex flexDirection="column" gap={4}>
          <Heading level={1}>CSV Lookup File Uploader</Heading>
          <Paragraph>
            Upload a CSV file to the Grail Resource Store. The file is validated
            locally, previewed with the lookup:test-pattern endpoint, and then
            written with lookup:upload.
          </Paragraph>
        </Flex>
      </Flex>

      <FormField required>
        <Label>Upload lookup CSV</Label>
        <Flex flexDirection="column" gap={8}>
          <input
            ref={fileInputRef}
            type="file"
            accept=".csv,text/csv"
            onChange={handleFileChange}
            style={{ display: "none" }}
          />

          {!file ? (
            <div
              role="button"
              tabIndex={0}
              onClick={openFilePicker}
              onKeyDown={handleDropZoneKeyDown}
              onDragEnter={handleDragEnter}
              onDragOver={handleDragOver}
              onDragLeave={handleDragLeave}
              onDrop={handleDrop}
              style={{
                display: "flex",
                flexDirection: "column",
                alignItems: "center",
                justifyContent: "center",
                gap: 8,
                padding: "32px 24px",
                borderRadius: 8,
                border: `2px dashed var(--dt-colors-border-neutral-default, #c6c7d5)`,
                backgroundColor: isDragActive
                  ? "var(--dt-colors-background-container-primary-default, #f1f2f9)"
                  : "var(--dt-colors-background-container-neutral-default, #f9f9fa)",
                cursor: "pointer",
                transition: "background-color 120ms ease, border-color 120ms ease",
                outline: "none",
                textAlign: "center",
              }}
              aria-label="Upload CSV file"
            >
              <UploadIcon
                size="large"
                aria-hidden
              />
              <Text>
                <strong>Click to browse</strong> or drag and drop a CSV file
                here
              </Text>
              <Text textStyle="small">
                CSV only. The first row must contain column names.
              </Text>
            </div>
          ) : (
            <Flex
              alignItems="center"
              gap={12}
              padding={12}
              style={{
                border: `1px solid var(--dt-colors-border-neutral-default, #dadbe4)`,
                borderRadius: 8,
                backgroundColor:
                  "var(--dt-colors-background-container-neutral-default, #f9f9fa)",
              }}
            >
              <DocumentIcon size="large" aria-hidden />
              <Flex flexDirection="column" gap={2} style={{ flex: 1, minWidth: 0 }}>
                <Text>
                  <strong>{file.name}</strong>
                </Text>
                <Text textStyle="small">
                  {Math.max(1, Math.round(file.size / 1024))} KB
                  {csvInfo ? ` · ${csvInfo.headers.length} columns · ${csvInfo.rowCount} rows` : ""}
                </Text>
              </Flex>
              <Button variant="default" onClick={openFilePicker}>
                Replace
              </Button>
              <Button variant="default" onClick={handleRemoveFile} color="critical">
                Remove
              </Button>
            </Flex>
          )}

          {csvError && (
            <MessageContainer variant="critical">
              <MessageContainer.Title>Invalid CSV</MessageContainer.Title>
              <MessageContainer.Description>{csvError}</MessageContainer.Description>
            </MessageContainer>
          )}

          {csvInfo && !csvError && (
            <MessageContainer variant="success">
              <MessageContainer.Title>CSV looks good</MessageContainer.Title>
              <MessageContainer.Description>
                Detected {csvInfo.headers.length} columns and {csvInfo.rowCount}{" "}
                data rows. Potential lookup fields:{" "}
                <Text as="span">
                  <strong>{csvInfo.uniqueFields.join(", ")}</strong>
                </Text>
                .
              </MessageContainer.Description>
            </MessageContainer>
          )}

          {csvInfo && csvInfo.warnings.length > 0 && (
            <MessageContainer variant="warning">
              <MessageContainer.Title>CSV warnings</MessageContainer.Title>
              <MessageContainer.Description>
                <ul style={{ margin: 0, paddingLeft: 16 }}>
                  {csvInfo.warnings.map((w) => (
                    <li key={w}>{w}</li>
                  ))}
                </ul>
              </MessageContainer.Description>
            </MessageContainer>
          )}
        </Flex>
      </FormField>

      <FormField required>
        <Label>Select lookup field</Label>
        <Select<string>
          name="lookupField"
          value={lookupField}
          onChange={(value) => {
            const raw: unknown = value;
            const next: string | null =
              typeof raw === "string"
                ? raw
                : Array.isArray(raw) && typeof raw[0] === "string"
                  ? raw[0]
                  : null;
            setLookupField(next);
            resetPreviewState();
          }}
          disabled={!csvInfo || (csvInfo?.uniqueFields.length ?? 0) === 0}
          clearable={false}
        >
          <Select.Content>
            {csvInfo?.uniqueFields.map((field) => (
              <Select.Option key={field} value={field}>
                {field}
              </Select.Option>
            ))}
          </Select.Content>
        </Select>
      </FormField>

      <FormField>
        <Label>Display name</Label>
        <TextInput
          value={displayName}
          onChange={(value) => {
            setDisplayName(value);
            setUploadResult(null);
            setUploadError(null);
          }}
          placeholder={
            file ? fileNameWithoutExtension(file.name) : "Optional display name"
          }
        />
      </FormField>

      {targetFilePath && csvInfo && !csvError && (
        <Text>
          Target path: <strong>{targetFilePath}</strong>
        </Text>
      )}

      <Flex gap={12} flexWrap="wrap">
        <Button
          variant="emphasized"
          color="primary"
          onClick={() => {
            void handlePreview();
          }}
          disabled={!canPreview}
          loading={isPreviewing}
        >
          Preview the data
        </Button>
        <Button
          variant="emphasized"
          color="success"
          onClick={() => {
            void handleUpload();
          }}
          disabled={!canUpload}
          loading={isUploading}
        >
          Upload the CSV
        </Button>
        <Button
          variant="default"
          onClick={handleReset}
          disabled={!isFormDirty || isPreviewing || isUploading}
        >
          Reset form
        </Button>
      </Flex>

      {previewError && (
        <MessageContainer variant="critical">
          <MessageContainer.Title>Preview failed</MessageContainer.Title>
          <MessageContainer.Description>{previewError}</MessageContainer.Description>
        </MessageContainer>
      )}

      {previewData && (
        <Flex flexDirection="column" gap={8}>
          <Heading level={3}>
            Preview
            {previewNumberOfRecords !== null && (
              <Text as="span">
                {" "}
                ({Math.min(previewData.length, 100)} of {previewNumberOfRecords}{" "}
                matched records)
              </Text>
            )}
          </Heading>
          {csvInfo &&
            previewNumberOfRecords !== null &&
            previewNumberOfRecords !== csvInfo.rowCount && (
              <MessageContainer variant="warning">
                <MessageContainer.Title>Row count mismatch</MessageContainer.Title>
                <MessageContainer.Description>
                  Local parser counted {csvInfo.rowCount} data rows, but the
                  Dynatrace parser matched {previewNumberOfRecords}. Some rows
                  may be malformed and would be silently dropped on upload.
                </MessageContainer.Description>
              </MessageContainer>
            )}
          {previewData.length === 0 ? (
            <MessageContainer variant="warning">
              <MessageContainer.Title>No records matched</MessageContainer.Title>
              <MessageContainer.Description>
                The parse pattern produced zero records. Check the CSV format.
              </MessageContainer.Description>
            </MessageContainer>
          ) : (
            <DataTable data={previewRows} columns={previewColumns} fullWidth />
          )}
        </Flex>
      )}

      {uploadError && (
        <MessageContainer variant="critical">
          <MessageContainer.Title>Upload failed</MessageContainer.Title>
          <MessageContainer.Description>{uploadError}</MessageContainer.Description>
        </MessageContainer>
      )}

      {uploadResult && (
        <MessageContainer variant="success">
          <MessageContainer.Title>Upload succeeded</MessageContainer.Title>
          <MessageContainer.Description>
            Stored {uploadResult.records} records at{" "}
            <strong>{targetFilePath}</strong>. Pattern matches:{" "}
            {uploadResult.patternMatches}. Discarded duplicates:{" "}
            {uploadResult.discardedDuplicates}. File size:{" "}
            {uploadResult.fileSize} bytes.
          </MessageContainer.Description>
        </MessageContainer>
      )}
    </Flex>
  );
};
