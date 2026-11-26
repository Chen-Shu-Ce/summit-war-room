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

  // Projects
  const proj1 = await prisma.project.upsert({
    where: { id: "proj-sy-001" },
    update: {},
    create: { id: "proj-sy-001", legalEntityId: sy.id, code: "SY-A01", name: "台北辦公大樓新建工程" },
  });
  await prisma.project.upsert({
    where: { id: "proj-cc-001" },
    update: {},
    create: { id: "proj-cc-001", legalEntityId: cc.id, code: "CC-B01", name: "高雄廠房改建工程" },
  });
  await prisma.project.upsert({
    where: { id: "proj-yq-001" },
    update: {},
    create: { id: "proj-yq-001", legalEntityId: yq.id, code: "YQ-C01", name: "新竹科技園區整地工程" },
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
