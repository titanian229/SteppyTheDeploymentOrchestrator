// Starts a CodeBuild execution
export const type = "CodeBuild";

export const handler = async (params: any) => {
  const { CodeBuildClient, StartBuildCommand } = require("@aws-sdk/client-codebuild");
  const client = new CodeBuildClient({ region: "ca-central-1" });

  const { codeBuildName, environmentVariableOverrides = [], sourceVersion } = params;

  const command = new StartBuildCommand({
    projectName: codeBuildName,
    sourceVersion: sourceVersion,
    environmentVariablesOverride: environmentVariableOverrides,
  });

  const data = await client.send(command);

  return data;
};

export const validator = (params: any) => {
  const { codeBuildName, sourceVersion, environmentVariableOverrides } = params;

  // TODO: Could check for permission for the step function / this Lambda to start the CodeBuild project
  if (!codeBuildName || !sourceVersion) {
    return false;
  }

  if (environmentVariableOverrides && !Array.isArray(environmentVariableOverrides)) {
    return false;
  }

  return true;
};
