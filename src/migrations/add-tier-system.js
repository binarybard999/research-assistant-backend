export async function up(db) {
    await db.collection("users").updateMany(
        {},
        {
            $set: {
                tier: "free",
                uploadLimits: {
                    concurrentPapers: 3,
                    monthlyUploads: 10,
                },
                usage: {
                    currentMonthUploads: 0,
                    totalChats: 0,
                },
            },
        }
    );
}

export async function down(db) {
    await db.collection("users").updateMany(
        {},
        {
            $unset: {
                tier: 1,
                uploadLimits: 1,
                usage: 1,
            },
        }
    );
}
