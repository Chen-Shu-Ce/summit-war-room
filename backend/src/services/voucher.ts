import prisma from "../prisma";
import { generateDocNumber } from "./doc-number";

export async function autoCreateVoucher(paymentClaim: {
  id: string;
  docNumber: string;
  legalEntityId: string;
  projectId: string;
  totalAmount: number;
}) {
  const docNumber = await generateDocNumber(paymentClaim.legalEntityId, "VOUCHER");

  return prisma.voucher.create({
    data: {
      docNumber,
      paymentClaimId: paymentClaim.id,
      legalEntityId: paymentClaim.legalEntityId,
      projectId: paymentClaim.projectId,
      amount: paymentClaim.totalAmount,
    },
  });
}
