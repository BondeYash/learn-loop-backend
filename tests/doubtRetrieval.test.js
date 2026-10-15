import test from "node:test";
import assert from "node:assert/strict";
import { PDFDocument } from "pdf-lib";
import { extractDoubtPdf } from "../services/doubtPdf.js";
import { chunkPages, searchTerms } from "../services/doubtRetrieval.js";

test("PDF extraction retains real page numbers and rejects image-only material", async () => {
  const pdf = await PDFDocument.create();
  pdf.addPage().drawText("RAM is volatile memory used for temporary work.");
  pdf.addPage().drawText("ROM retains startup instructions after power is removed.");
  const result = await extractDoubtPdf(Buffer.from(await pdf.save()));
  assert.equal(result.textPages, 2); assert.equal(result.chunks[0].page, 1); assert.equal(result.chunks[1].page, 2);
  assert.match(result.chunks[1].text, /ROM/);
  const blank = await PDFDocument.create(); blank.addPage();
  await assert.rejects(extractDoubtPdf(Buffer.from(await blank.save())), /No searchable text/);
});
test("passage bounds, page provenance and bilingual terms remain deterministic", () => {
  const result = chunkPages(["RAM memory " + "temporary working memory ".repeat(150), "मेमोरी में सूचना संग्रहीत होती है। RAM temporary memory."]);
  assert.ok(result.chunks.length > 2); assert.ok(result.chunks.every(chunk => chunk.text.length <= 1100));
  assert.ok(result.chunks.some(chunk => chunk.page === 2 && chunk.terms.includes("मेमोरी")));
  assert.ok(searchTerms("क्या RAM memory है?").includes("ram"));
  assert.ok(!searchTerms("what is the RAM memory").includes("the"));
  assert.deepEqual(searchTerms("PrimaryMemory SecondaryMemory"), ["primary", "memory", "secondary"]);
  assert.throws(() => chunkPages(["x".repeat(100001)]), /too much extracted text/);
});
