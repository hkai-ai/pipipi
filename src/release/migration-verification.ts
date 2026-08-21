/** migration 应用后的二次空跑验证 */
export type MigrationVerification = Readonly<{
    appliedCount: number;
    verificationCount: 0;
}>;

export async function applyMigrationsAndVerify(
    migrate: () => Promise<readonly unknown[]>,
): Promise<MigrationVerification> {
    const applied = await migrate();
    const verification = await migrate();
    if (verification.length !== 0) {
        throw new Error(
            "Migration verification found migrations on the second run",
        );
    }
    return Object.freeze({
        appliedCount: applied.length,
        verificationCount: 0,
    });
}
