// This Lambda is responsible for executing different step types
class Executor {
  types: {
    [key: string]: {
      handler: (params: any) => Promise<any>;
      paramValidator: (params: any) => boolean;
      confirmationParser: () => Boolean;
    };
  };

  constructor() {
    this.types = {};
  }

  registerType(type: string | number, handler: any, paramValidator = null, confirmationParser?: () => Boolean) {
    this.types[type] = {
      handler,
      paramValidator: paramValidator || (() => true),
      confirmationParser: confirmationParser || (() => true),
    };
  }
}

const executor = new Executor();

// Used to extend the executor with new step types, any unknown steps will be passed here, if they match the provided function will be executed
executor.registerType("CodeBuild", async (params: any) => {
  const { CodeBuildClient, StartBuildCommand } = require("@aws-sdk/client-codebuild");
  const client = new CodeBuildClient({ region: "ca-central-1" });

  const { codeBuildName, environmentVariableOverrides = [], sourceVersion } = params;

  const command = new StartBuildCommand({
    projectName: codeBuildName,
    sourceVersion: sourceVersion,
    environmentVariablesOverride: environmentVariableOverrides,
  });

  const data = await client.send(command);

  if (typeof data.build === "undefined") {
    throw new Error("CodeBuild failed");
  }
});
