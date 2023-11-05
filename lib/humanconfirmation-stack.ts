import * as cdk from "aws-cdk-lib";
import { Construct } from "constructs";
import {
  aws_stepfunctions as sfn,
  aws_stepfunctions_tasks as tasks,
  aws_iam as iam,
  aws_logs as logs,
  aws_lambda as lambda,
  aws_apigateway as apigateway,
  aws_ssm as ssm,
  aws_s3 as s3,
} from "aws-cdk-lib";

interface DeployOrchHumanStepProps extends cdk.StackProps {
  // With a multi-account setup, the name of the workload account to suffix resources created
  readonly stageName: "sbx01" | "qa01" | "staging01" | "prod01";
  // Name of the application, used in prefix for resources
  readonly applicationName: string;
  // Step Function ARN of parent
  readonly parentStepFunctionArn: string;
}

const sharedLambdaProps = {
  runtime: lambda.Runtime.NODEJS_18_X,
  handler: "index.handler",
  timeout: cdk.Duration.seconds(25),
  memorySize: 1024,
};

export class DeployOrchHumanStep extends cdk.Stack {
  constructor(scope: Construct, id: string, props: DeployOrchHumanStepProps) {
    super(scope, id, props);
    const { applicationName = "deploymentOrchestrator", stageName, parentStepFunctionArn } = props;

    const stackSuffix = `${stageName}-cac1-01`;

    // Lambda function to confirm human action and continue step function execution

    const lambdaRole = new iam.Role(this, `iam-${applicationName}LambdaDOHumanStepRole`, {
      assumedBy: new iam.ServicePrincipal("lambda.amazonaws.com"),
      roleName: `iam-${applicationName}LambdaDOHumanStepRole-${stackSuffix}`,
      description: "Role for DeploymentOrchestrator Lambda to continue step function execution",
      managedPolicies: [iam.ManagedPolicy.fromAwsManagedPolicyName("service-role/AWSLambdaBasicExecutionRole")],
    });

    // Permissions for Lambda to send success or failure to Step Function state
    lambdaRole.addToPolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: ["states:SendTaskSuccess", "states:SendTaskFailure"],
        // TODO: Make a third stack for the role of this Lambda as this causes a circular dependency
        resources: [parentStepFunctionArn],
      })
    );

    // Lambda that loops on steps and starts each step, this could also be a Map with a single execution allowed but this allows for a little extra fanciness
    const confirmationLambda = new lambda.Function(this, `lambda-${applicationName}HumanConfirmation`, {
      code: lambda.Code.fromAsset("src/lambda/humanConfirmation", {
        exclude: ["test/*", "*.ts", "*.js.map", "*.d.ts"],
      }),
      functionName: `lambda-${applicationName}HumanConfirmation-${stackSuffix}`,
      description: "Part of DeploymentOrchestrator, used to send task success or failure to step function",
      role: lambdaRole,
      ...sharedLambdaProps,
    });

    // APIGW to trigger Lambda
    const api = new apigateway.RestApi(this, `api-${applicationName}HumanConfirmation`, {
      restApiName: `api-${applicationName}HumanConfirmation-${stackSuffix}`,
      description: "Part of DeploymentOrchestrator, used to send task success or failure to step function",
    });

    const integration = new apigateway.LambdaIntegration(confirmationLambda, {
      // proxy: false,
      allowTestInvoke: false,
      integrationResponses: [
        {
          statusCode: "200",
          responseTemplates: {
            "application/json": JSON.stringify({
              status: "success",
            }),
          },
        },
      ],
    });

    const apiResource = api.root.addResource("humanConfirmation");

    apiResource.addMethod(
      "GET",
      integration
      //  {
      //   methodResponses: [
      //     {
      //       statusCode: "200",
      //       responseModels: {
      //         "application/json": apigateway.Model.EMPTY_MODEL,
      //       },
      //     },
      //   ],
      // }
    );

    new ssm.StringParameter(this, `ssm-${applicationName}HumanConfirmationApiUrl`, {
      parameterName: `/${applicationName}/${stageName}/humanConfirmationApiUrl`,
      description: "URL for APIGW to trigger Lambda",
      stringValue: api.urlForPath(apiResource.path),
    });

    // Permissions for APIGW to invoke Lambda
    // confirmationLambda.addPermission("apigateway", {
    //   principal: new iam.ServicePrincipal("apigateway.amazonaws.com"),
    //   action: "lambda:InvokeFunction",
    //   sourceArn: api.arnForExecuteApi(),
    // });
  }
}
