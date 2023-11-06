import { type as cbType, handler as cbHandler, validator as cbValidator } from "./stepTypes/codebuild";

// This Lambda is responsible for executing different step types
class Executor {
  types: {
    [key: string]: {
      handler: (params: any) => Promise<any> | Promise<void>;
      paramValidator: (params: any) => boolean;
      confirmationParser: (response: any) => boolean;
    };
  };

  constructor() {
    this.types = {};
  }

  registerType(
    type: string,
    handler: (params: any) => Promise<any> | Promise<void>,
    paramValidator?: (params: any) => boolean,
    confirmationParser?: (result: any) => boolean
  ) {
    this.types[type] = {
      handler,
      paramValidator: paramValidator || (() => true),
      confirmationParser: confirmationParser || (() => true),
    };
  }

  async execute(type: string, params: any): Promise<void> {
    const strategy = this.types[type];

    if (!strategy) {
      throw new Error(`Unknown type ${type}`);
    }

    if (!strategy.paramValidator(params)) {
      throw new Error(`Invalid params for type ${type}`);
    }

    const result = await strategy.handler(params);

    if (!strategy.confirmationParser(result)) {
      throw new Error(`Confirmation failed for type ${type}`);
    }
  }
}

const executor = new Executor();

// Used to extend the executor with new step types, any unknown steps will be passed here, if they match the provided function will be executed
executor.registerType(cbType, cbHandler, cbValidator);

// executor.registerType(
//   "CodeBuild",
//   async (params: any) => {
//     const { CodeBuildClient, StartBuildCommand } = require("@aws-sdk/client-codebuild");
//     const client = new CodeBuildClient({ region: "ca-central-1" });

//     const { codeBuildName, environmentVariableOverrides = [], sourceVersion } = params;

//     const command = new StartBuildCommand({
//       projectName: codeBuildName,
//       sourceVersion: sourceVersion,
//       environmentVariablesOverride: environmentVariableOverrides,
//     });

//     const data = await client.send(command);

//     return data;
//   },
//   (params: any) => {
//     const { codeBuildName, sourceVersion, environmentVariableOverrides } = params;

//     // TODO: Could check for permission for the step function / this Lambda to start the CodeBuild project
//     if (!codeBuildName || !sourceVersion) {
//       return false;
//     }

//     if (environmentVariableOverrides && !Array.isArray(environmentVariableOverrides)) {
//       return false;
//     }

//     return true;
//   }
// );

export const handler = async (event: { type: string; params: any }) => {
  const { type, params } = event;

  if (!type || !params) {
    throw new Error("Invalid request");
  }

  try {
    await executor.execute(type, params);
  } catch (error) {
    console.error(error);
    // Rethrow to stop execution
    throw error;
  }
};
