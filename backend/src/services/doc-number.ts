import prisma from "../prisma";

const TYPE_CODES: Record<string, string> = {
  PROJECT: "J",
  SUBCONTRACT_PLAN: "B",
  ENGINEERING_BUDGET: "E",
  SR: "S",
  PR: "R",
  PO: "P",
  INSPECTION: "A",
  PAYMENT_CLAIM: "I",
  VOUCHER: "V",
  CHANGE_ORDER: "C",
};

export async function generateDocNumber(legalEntityId: string, docType: string): Promise<string> {
  const entity = await prisma.legalEntity.findUniqueOrThrow({ where: { id: legalEntityId } });
  const typeCode = TYPE_CODES[docType];
  if (!typeCode) throw new Error(`Unknown doc type: ${docType}`);

  const now = new Date();
  const yearMonth = `${String(now.getFullYear() % 100).padStart(2, "0")}${String(now.getMonth() + 1).padStart(2, "0")}`;

  const seq = await prisma.docSequence.upsert({
    where: {
      legalEntityId_typeCode_yearMonth: { legalEntityId, typeCode, yearMonth },
    },
    create: { legalEntityId, typeCode, yearMonth, lastSeq: 1 },
    update: { lastSeq: { increment: 1 } },
  });

  // Format: {法人2碼}{類型碼1碼}-{YYMM}{NNN}
  return `${entity.code}${typeCode}-${yearMonth}${String(seq.lastSeq).padStart(3, "0")}`;
}
