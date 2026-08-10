import {
    checkDeploymentEnvironment,
    parseDeploymentRole,
} from "../app/deployment-environment.js";

const arguments_ = process.argv.slice(2);
if (arguments_.length !== 1) {
    throw new Error("Specify exactly one deployment role");
}

const role = parseDeploymentRole(arguments_[0]);
const check = checkDeploymentEnvironment(process.env, role, {
    includeProviderCredentials: true,
});

if (check.missingVariables.length > 0) {
    console.error(
        JSON.stringify({
            event: "deployment_environment_check_failed",
            role,
            missingVariables: check.missingVariables,
        }),
    );
    process.exitCode = 1;
} else {
    console.log(
        JSON.stringify({
            event: "deployment_environment_check_passed",
            role,
            requiredVariables: check.requiredVariables,
        }),
    );
}
