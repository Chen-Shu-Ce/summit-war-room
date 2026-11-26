import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

async function main() {
  // Legal Entities
  const sy = await prisma.legalEntity.upsert({
    where: { code: "SY" },
    update: {},
    create: { code: "SY", name: "森陽" },
  });
  const cc = await prisma.legalEntity.upsert({
    where: { code: "CC" },
    update: {},
    create: { code: "CC", name: "春合" },
  });
  const yq = await prisma.legalEntity.upsert({
    where: { code: "YQ" },
    update: {},
    create: { code: "YQ", name: "涌全" },
  });

  // Projects (status ACTIVE = 已過完立案→分包→預算簽核流程)
  const proj1 = await prisma.project.upsert({
    where: { id: "proj-sy-001" },
    update: {},
    create: {
      id: "proj-sy-001", docNumber: "SYJ-2611001", legalEntityId: sy.id, code: "SY-A01",
      name: "台北辦公大樓新建工程", status: "ACTIVE",
      clientName: "台北市政府", location: "台北市信義區", contractAmount: 50000000,
      startDate: "2026-01", endDate: "2028-06", managerId: "user-03", createdBy: "user-03", updatedBy: "user-03",
    },
  });
  await prisma.project.upsert({
    where: { id: "proj-cc-001" },
    update: {},
    create: {
      id: "proj-cc-001", docNumber: "CCJ-2611001", legalEntityId: cc.id, code: "CC-B01",
      name: "高雄廠房改建工程", status: "REGISTERED",
      clientName: "高雄市政府", location: "高雄市前鎮區", contractAmount: 30000000,
      createdBy: "user-03", updatedBy: "user-03",
    },
  });
  await prisma.project.upsert({
    where: { id: "proj-yq-001" },
    update: {},
    create: {
      id: "proj-yq-001", docNumber: "YQJ-2611001", legalEntityId: yq.id, code: "YQ-C01",
      name: "新竹科技園區整地工程", status: "DRAFT",
      clientName: "新竹科技園區管理局", location: "新竹縣寶山鄉", contractAmount: 20000000,
      createdBy: "user-03", updatedBy: "user-03",
    },
  });

  // Subcontract Plan for proj-sy-001 (APPROVED)
  await prisma.subcontractPlan.upsert({
    where: { id: "sp-sy-001" },
    update: {},
    create: {
      id: "sp-sy-001", docNumber: "SYB-2611001", legalEntityId: sy.id, projectId: "proj-sy-001",
      createdBy: "user-03", updatedBy: "user-05", status: "APPROVED",
      title: "台北辦公大樓分包計畫", totalAmount: 40000000,
      items: JSON.stringify([
        { seq: 1, workCategory: "鋼構", description: "鋼構主體工程含施工架", estimatedAmount: 12000000, vendorType: "專業分包" },
        { seq: 2, workCategory: "水電", description: "水電消防工程", estimatedAmount: 8000000, vendorType: "專業分包" },
        { seq: 3, workCategory: "土木", description: "土木結構及基礎工程", estimatedAmount: 10000000, vendorType: "專業分包" },
        { seq: 4, workCategory: "裝修", description: "室內裝修及外牆", estimatedAmount: 6000000, vendorType: "專業分包" },
        { seq: 5, workCategory: "勞務", description: "一般勞務工", estimatedAmount: 4000000, vendorType: "勞務分包" },
      ]),
    },
  });

  // Engineering Budget for proj-sy-001 (APPROVED)
  await prisma.engineeringBudget.upsert({
    where: { id: "eb-sy-001" },
    update: {},
    create: {
      id: "eb-sy-001", docNumber: "SYE-2611001", legalEntityId: sy.id, projectId: "proj-sy-001",
      subcontractPlanId: "sp-sy-001", createdBy: "user-03", updatedBy: "user-08", status: "APPROVED",
      title: "台北辦公大樓工程預算書", totalAmount: 20000000,
      items: JSON.stringify([
        { seq: 1, category: "MATERIAL", itemName: "SD420 #8 鋼筋", specification: "D25", unit: "噸", quantity: 50, unitPrice: 28000, amount: 1400000 },
        { seq: 2, category: "MATERIAL", itemName: "預拌混凝土 3000psi", specification: "3000psi", unit: "m³", quantity: 500, unitPrice: 2800, amount: 1400000 },
        { seq: 3, category: "MATERIAL", itemName: "模板", specification: "12mm", unit: "坪", quantity: 1000, unitPrice: 2200, amount: 2200000 },
        { seq: 4, category: "EQUIPMENT", itemName: "50噸吊車", specification: "50T", unit: "日", quantity: 60, unitPrice: 35000, amount: 2100000 },
        { seq: 5, category: "EQUIPMENT", itemName: "挖土機", specification: "PC200", unit: "日", quantity: 30, unitPrice: 30000, amount: 900000 },
        { seq: 6, category: "ENGINEERING", itemName: "鋼構工程", specification: "", unit: "式", quantity: 1, unitPrice: 8000000, amount: 8000000 },
        { seq: 7, category: "LABOR", itemName: "模板工", specification: "", unit: "工", quantity: 500, unitPrice: 3500, amount: 1750000 },
        { seq: 8, category: "LABOR", itemName: "鋼筋工", specification: "", unit: "工", quantity: 400, unitPrice: 3800, amount: 1520000 },
        { seq: 9, category: "LABOR", itemName: "泥作工", specification: "", unit: "工", quantity: 200, unitPrice: 3650, amount: 730000 },
      ]),
    },
  });

  // Users (10 roles)
  const users = [
    { id: "user-01", name: "王建民", email: "wang@test.com", role: "申請人" },
    { id: "user-02", name: "林志玲", email: "lin@test.com", role: "工地承辦" },
    { id: "user-03", name: "陳文茜", email: "chen@test.com", role: "工程主管" },
    { id: "user-04", name: "李明哲", email: "li@test.com", role: "採購承辦" },
    { id: "user-05", name: "張雅琴", email: "zhang@test.com", role: "採購主管" },
    { id: "user-06", name: "黃美玲", email: "huang@test.com", role: "財務" },
    { id: "user-07", name: "劉德華", email: "liu@test.com", role: "營運長" },
    { id: "user-08", name: "周杰倫", email: "zhou@test.com", role: "總經理" },
    { id: "user-09", name: "蔡依林", email: "tsai@test.com", role: "董事長" },
    { id: "user-10", name: "吳宗憲", email: "wu@test.com", role: "系統管理" },
  ];

  for (const u of users) {
    await prisma.user.upsert({
      where: { id: u.id },
      update: {},
      create: u,
    });
  }

  // Budgets for proj-sy-001
  const budgetCategories = [
    { projectId: "proj-sy-001", category: "MATERIAL", budgetAmount: 5000000 },
    { projectId: "proj-sy-001", category: "EQUIPMENT", budgetAmount: 3000000 },
    { projectId: "proj-sy-001", category: "ENGINEERING", budgetAmount: 8000000 },
    { projectId: "proj-sy-001", category: "LABOR", budgetAmount: 4000000 },
    { projectId: "proj-sy-001", category: "TOTAL", budgetAmount: 20000000 },
  ];
  for (const b of budgetCategories) {
    await prisma.budget.upsert({
      where: { projectId_category: { projectId: b.projectId, category: b.category } },
      update: {},
      create: { ...b, usedAmount: 0, executionRate: 0, alertLevel: "NORMAL" },
    });
  }

  // DocSequence counters (must match seed docNumbers to avoid collisions)
  const seqEntries = [
    { legalEntityId: sy.id, typeCode: "J", yearMonth: "2611", lastSeq: 1 },
    { legalEntityId: cc.id, typeCode: "J", yearMonth: "2611", lastSeq: 1 },
    { legalEntityId: yq.id, typeCode: "J", yearMonth: "2611", lastSeq: 1 },
    { legalEntityId: sy.id, typeCode: "B", yearMonth: "2611", lastSeq: 1 },
    { legalEntityId: sy.id, typeCode: "E", yearMonth: "2611", lastSeq: 1 },
  ];
  for (const s of seqEntries) {
    await prisma.docSequence.upsert({
      where: { legalEntityId_typeCode_yearMonth: { legalEntityId: s.legalEntityId, typeCode: s.typeCode, yearMonth: s.yearMonth } },
      update: { lastSeq: s.lastSeq },
      create: s,
    });
  }

  // Unit price seed data
  const unitPrices = [
    { category: "MATERIAL", itemName: "SD420 #8 鋼筋", unit: "噸", unitPrice: 28000, vendorName: "中鋼", region: "北部" },
    { category: "MATERIAL", itemName: "SD420 #8 鋼筋", unit: "噸", unitPrice: 27500, vendorName: "東鋼", region: "北部" },
    { category: "MATERIAL", itemName: "預拌混凝土 3000psi", unit: "m³", unitPrice: 2800, vendorName: "國產建材", region: "北部" },
    { category: "EQUIPMENT", itemName: "50噸吊車", unit: "日", unitPrice: 35000, vendorName: "宏泰起重", region: "北部" },
    { category: "LABOR", itemName: "模板工", unit: "工", unitPrice: 3500, region: "北部" },
    { category: "LABOR", itemName: "鋼筋工", unit: "工", unitPrice: 3800, region: "北部" },
  ];
  for (const up of unitPrices) {
    await prisma.unitPriceRecord.create({ data: up });
  }

  console.log("Seed completed:");
  console.log(`  Legal entities: ${sy.code}, ${cc.code}, ${yq.code}`);
  console.log(`  Projects: ${proj1.code} + 2 more`);
  console.log(`  Users: ${users.length} users across 10 roles`);
  console.log(`  Budgets: ${budgetCategories.length} categories for proj-sy-001`);
  console.log(`  Unit prices: ${unitPrices.length} records`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
