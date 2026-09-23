/** 固定照片风格 Runtime Skill 的本地路径与内容摘要。 */
import type { InstalledSkillRef } from "../../agent-runtime/skills.js";
import type { PhotoPosterStyle } from "./style.js";

const hashes: Readonly<Record<PhotoPosterStyle, string>> = {
    dopamine:
        "f70a9298b01ea5c088b164b4463f07611cd29fcb5f01974517720a111600ab5e",
    "mono-color":
        "4efba752b8e0574d3a8196727667b5db63f569b641f3a4746d9863b477da9a91",
    "travel-abstraction":
        "5cc7d1f2364178b94c85c008e7d6315efd2a97e2a2ab5b5a091790b3a1f19528",
    crayon: "19d3978b0bca2dd0d98bea773c635ff5b42ab36c20f19311b10a251eb0f85de0",
    monochrome:
        "dc21fd4205704fe4ff0619db503a6683b7ef70921829496ff37d15c3889949d1",
    woodcut: "fbfb6593a8133a64159a9e0423f214c6a99ffc0d62e43eeeecc6b84bb31f04f3",
    "photo-doodle-collage":
        "3205dae9d148a5187b97b13cede3c3364313eca2299193e94b2d65a936aa9009",
};

export function createPhotoPosterSkillRefs(
    style: PhotoPosterStyle,
): readonly InstalledSkillRef[] {
    const name =
        style === "photo-doodle-collage"
            ? "photo-doodle-collage-prompt"
            : `${style}-photo-poster-prompt`;
    return Object.freeze([
        Object.freeze({
            name,
            version: "v1",
            sha256: hashes[style],
            path: `.pi/skills/${name}`,
        }),
    ]);
}
