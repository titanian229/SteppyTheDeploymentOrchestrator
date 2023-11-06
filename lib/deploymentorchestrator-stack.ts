import * as cdk from "aws-cdk-lib";
import { Construct } from "constructs";
import {
  aws_stepfunctions as sfn,
  aws_stepfunctions_tasks as tasks,
  aws_iam as iam,
  aws_logs as logs,
  aws_lambda as lambda,
  aws_ssm as ssm,
  aws_s3 as s3,
} from "aws-cdk-lib";

interface DeploymentOrchestratorProps extends cdk.StackProps {
  // With a multi-account setup, the name of the workload account to suffix resources created
  readonly stageName: "sbx01" | "qa01" | "staging01" | "prod01";
  // Human readable name of environment, used in notifications
  readonly environmentName: "DEV" | "QA" | "STAGE" | "PROD";
  // The AWS account number of the target workload account
  // readonly targetAWSAccountNumber: string;
  // SNS topic name to send notifications to
  readonly snsNotificationTopicName: string;
  // CodeBuild ARNs to allow access to
  readonly codeBuildArns: string[];
  // Name of the application, used in prefix for resources
  readonly applicationName: string;
}

const sharedLambdaProps = {
  runtime: lambda.Runtime.NODEJS_18_X,
  handler: "index.handler",
  timeout: cdk.Duration.seconds(25),
  memorySize: 1024,
};

export class DeploymentOrchestrator extends cdk.Stack {
  constructor(scope: Construct, id: string, props: DeploymentOrchestratorProps) {
    super(scope, id, props);
    const {
      applicationName = "deploymentOrchestrator",
      stageName,
      snsNotificationTopicName,
      environmentName,
      codeBuildArns,
      tags,
      env,
    } = props;

    const snsNotificationTopicArn = `arn:aws:sns:${this?.region}:${this?.account}:${snsNotificationTopicName}`;

    const stackSuffix = `${stageName}-cac1-01`;

    // Input S3 bucket
    const inputBucket = new s3.Bucket(this, `s3-${applicationName.toLowerCase()}inputbucket`, {
      // Private
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      bucketName: `s3-${applicationName.toLowerCase()}inputbucket-${stackSuffix}`,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      // TODO: Each input file kept for posterity, or replaced and the sheet name specified?
      // autoDeleteObjects: true,
      // lifecycleRules: [ // { // expiration: cdk.Duration.days(7), // }, // ],
    });

    // Lambdas
    const lambdaS3AccessRole = new iam.Role(this, `iam-${applicationName}LambdaS3AccessRole`, {
      assumedBy: new iam.ServicePrincipal("lambda.amazonaws.com"),
      roleName: `iam-${applicationName}LambdaS3AccessRole-${stackSuffix}`,
      description: "Role for DeploymentOrchestrator Lambdas to access S3 buckets",
      managedPolicies: [iam.ManagedPolicy.fromAwsManagedPolicyName("service-role/AWSLambdaBasicExecutionRole")],
    });

    lambdaS3AccessRole.addToPolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: ["s3:PutObject", "s3:PutObjectAcl", "s3:GetObject", "s3:ListBucket"],
        resources: [inputBucket.arnForObjects("*"), inputBucket.bucketArn],
      })
    );

    // Lambda that loops on steps and starts each step, this could also be a Map with a single execution allowed but this allows for a little extra fanciness
    const steppyLambda = new lambda.Function(this, `lambda-${applicationName}steppy`, {
      code: lambda.Code.fromAsset("src/lambda/steppy", { exclude: ["test/*", "*.ts", "*.js.map", "*.d.ts"] }),
      functionName: `lambda-${applicationName}Steppy-${stackSuffix}`,
      description: "Part of DeploymentOrchestrator, steppy runs through deployment steps",
      ...sharedLambdaProps,
    });

    // TODO: SNS topic that runs this?

    // Getting the human confirmation stack's APIGW endpoint
    // TODO: Move this to a nested stack
    const humanConfirmationAPIGWEndpoint = ssm.StringParameter.valueForStringParameter(
      this,
      `/${applicationName}/${stageName}/humanConfirmationApiUrl`
    );

    // Lambda that sends a link to resolve human steps
    const humanWaitLambda = new lambda.Function(this, `lambda-${applicationName}HumanWait`, {
      code: lambda.Code.fromAsset("src/lambda/humanConfirmationMessage", {
        exclude: ["test/*", "*.ts", "*.js.map", "*.d.ts"],
      }),
      functionName: `lambda-${applicationName}HumanMessage-${stackSuffix}`,
      description: "Part of DeploymentOrchestrator, sends notification with approve or rejection links",
      environment: {
        CONFIRMATION_URL: humanConfirmationAPIGWEndpoint,
        SNS_TOPIC_ARN: snsNotificationTopicArn,
      },
      ...sharedLambdaProps,
    });

    // Add SNS Publish permissions to Lambda
    humanWaitLambda.addToRolePolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: ["sns:Publish"],
        resources: [snsNotificationTopicArn],
      })
    );

    // State Machine
    const logGroup = new logs.LogGroup(this, `logs-${applicationName}`, { retention: logs.RetentionDays.ONE_WEEK });

    const loggingConfig: sfn.LogOptions = {
      level: sfn.LogLevel.ALL,
      includeExecutionData: true,
      destination: logGroup,
    };

    const executionRole = new iam.Role(this, `role-${applicationName}`, {
      assumedBy: new iam.ServicePrincipal("states.amazonaws.com"),
      roleName: `role-${applicationName}StepFunctionRole-${stackSuffix}`,
      description: "Role for DeploymentOrchestrator State Machine",
      // managedPolicies: [
      //   iam.ManagedPolicy.fromAwsManagedPolicyName("service-role/AWSLambdaBasicExecutionRole"),
      //   iam.ManagedPolicy.fromAwsManagedPolicyName("service-role/AWSLambdaRole"),
      // ],
    });

    executionRole.addToPolicy(
      new iam.PolicyStatement({
        actions: ["lambda:InvokeFunction"],
        resources: [steppyLambda.functionArn],
      })
    );

    executionRole.addToPolicy(
      new iam.PolicyStatement({
        actions: ["s3:PutObject", "s3:GetObject", "s3:ListBucket"],
        resources: [inputBucket.arnForObjects("*"), inputBucket.bucketArn],
      })
    );

    // Read S3 input task
    const readInputTask = new tasks.CallAwsService(this, `task-${applicationName}ReadInput`, {
      service: "S3",
      action: "getObject",
      parameters: { Bucket: inputBucket.bucketName, Key: "input.json" },
      resultPath: "$.input",
      iamResources: [inputBucket.arnForObjects("*")],
    });

    // Convert input to JSON task using Lambda for parsing and validation
    const convertInputTask = new tasks.LambdaInvoke(this, "ConvertInputTask", {
      lambdaFunction: new lambda.Function(this, `lambda-${applicationName}ConvertInput`, {
        code: lambda.Code.fromAsset("src/lambda/convertInput", {
          exclude: ["test/*", "*.ts", "*.js.map", "*.d.ts"],
        }),
        functionName: `lambda-${applicationName}ConvertInput-${stackSuffix}`,
        description: "Part of DeploymentOrchestrator, converts input to JSON",
        ...sharedLambdaProps,
      }),
      comment: "Convert input to JSON task using Lambda for parsing and validation",
      payload: sfn.TaskInput.fromObject({
        input: sfn.JsonPath.stringAt("$.input.Body"),
      }),
      resultPath: "$",
      resultSelector: {
        stages: sfn.JsonPath.stringAt("$.Payload.stages"),
        iterator: {
          count: sfn.JsonPath.stringAt("$.Payload.count"),
          index: -1,
          continue: true,
        },
        iteratorResults: [],
      },
    });

    // // Start pass notification task
    const startNotificationMessageTask = new sfn.Pass(this, `task-${applicationName}StartNotificationMessage`, {
      // TODO: Comment comment: "",
      resultPath: "$.message",
      result: sfn.Result.fromString(`DeploymentOrchestrator has started ${environmentName} deployment`),
    });

    const notifyTask = new tasks.CallAwsService(this, `task-${applicationName}Notify`, {
      service: "SNS",
      action: "publish",
      parameters: { TopicArn: snsNotificationTopicArn, Message: sfn.JsonPath.stringAt("$.message") },
      iamResources: [snsNotificationTopicArn],
      resultPath: sfn.JsonPath.DISCARD,
    });

    // // From here, the start of the actual stepper
    // // Comprised of stages with steps, stages are one linearly, all steps in a stage are run at the same time
    // // Notifications between stages, stages have names for notification
    // /*
    // {
    // stages: [
    //   {
    //     name: "stage1",
    //     steps: [
    //       {
    //         name: "step1",
    //         // Type can be: CodeBuild, CodePipeline, Human, Test, Notify, Wait
    //         type: "CodeBuild",
    //         codeBuildName: "my-codebuild-project",
    //         // Can be left out
    //         environmentVariableOverrides: [{name: "key", value: "value"}],
    //         // Can be left out to build selected branch in codebuild
    //         sourceVersion: {
    //           // Type is branch or tag
    //           type: "branch",
    //           value: "master"
    //         },
    //       },
    //       {
    //         name: "step2",
    //         // Type can be: CodeBuild, CodePipeline, Human, Test, Notify, Wait
    //         type: "Human",
    //         humanName: "James",
    //  message: "Please approve this deployment",
    //       }
    //     ]
    //   ]
    // }
    // */

    // // Steppy the steppin' Lambda
    const steppyLambdaTask = new tasks.LambdaInvoke(this, "SteppyLambdaTask", {
      lambdaFunction: steppyLambda,
      comment:
        "Steppy the steppin' Lambda, determines what stage the deployment is currently in and increments until complete",
      payload: sfn.TaskInput.fromObject({
        // Iterator stores the current stage and step, and increment values
        iterator: sfn.JsonPath.objectAt("$.iterator"),
        // Stages are the stages of the deployment
        stages: sfn.JsonPath.stringAt("$.stages"),
        // results of last iteration through map, used to stop if there were failures that should cause a stop, like a CodeBuild
        iteratorResults: sfn.JsonPath.stringAt("$.iteratorResults"),
      }),
      resultPath: "$.iterator",
      resultSelector: {
        index: sfn.JsonPath.stringAt("$.Payload.index"),
        count: sfn.JsonPath.stringAt("$.Payload.count"),
        continue: sfn.JsonPath.stringAt("$.Payload.continue"),
        // The current stages steps to be passed to the Map task
        currentStageSteps: sfn.JsonPath.stringAt("$.Payload.currentStageSteps"),
      },
    });

    // Human confirmation message task; sends a message to an SNS topic with approve and reject links
    const humanConfirmationTask = new tasks.LambdaInvoke(this, "HumanConfirmationLambda", {
      lambdaFunction: humanWaitLambda,
      comment: "Human confirmation message task; sends a message to an SNS topic with approve and reject links",
      payload: sfn.TaskInput.fromObject({
        taskToken: sfn.JsonPath.taskToken,
        message: sfn.JsonPath.stringAt("$.message"),
      }),
      integrationPattern: sfn.IntegrationPattern.WAIT_FOR_TASK_TOKEN,
    }).next(
      // Checks if the task was approved
      new sfn.Choice(this, `choice-${applicationName}HumanConfirmationChoice`, {
        comment: "Checks if the task was approved",
      })
        .when(
          sfn.Condition.stringEquals("$.action", "approve"),
          new sfn.Pass(this, `task-${applicationName}HumanConfirmationApproved`, {
            resultPath: "$.results",
            result: sfn.Result.fromObject({ message: "Human confirmation approved", success: true }),
          })
        )
        .when(
          sfn.Condition.stringEquals("$.action", "reject"),
          new sfn.Pass(this, `task-${applicationName}HumanConfirmationRejected`, {
            resultPath: "$.results",
            result: sfn.Result.fromObject({ message: "Human confirmation rejected", success: false }),
          })
        )
    );

    // // Completion notification task
    const completionNotificationTask = new tasks.CallAwsService(this, `task-${applicationName}CompletionNotification`, {
      service: "SNS",
      action: "publish",
      parameters: { TopicArn: snsNotificationTopicArn, Message: "Deployments complete" },
      iamResources: [snsNotificationTopicArn],
    });

    const checkCodeBuildComplete = new tasks.CallAwsService(this, `task-${applicationName}CheckCodeBuildComplete`, {
      service: "CodeBuild",
      action: "batchGetBuilds",
      parameters: { Ids: sfn.JsonPath.array(sfn.JsonPath.stringAt("$.CodeBuildResults.Build.Id")) },
      iamResources: [...codeBuildArns],
      resultPath: "$.CodeBuildGetBuilds",
    });

    const waitForCodeBuild = new sfn.Wait(this, `task-${applicationName}WaitForCodeBuild`, {
      time: sfn.WaitTime.duration(cdk.Duration.seconds(30)),
    });

    const codeBuildCompleteChoice = new sfn.Choice(this, `task-${applicationName}CodeBuildCompleteChoice`, {
      comment: "Choice on if CodeBuild is complete",
    })
      .when(
        sfn.Condition.stringEquals("$.CodeBuildGetBuilds.Builds[0].BuildStatus", "SUCCEEDED"),
        new sfn.Pass(this, `task-${applicationName}CodeBuildSucceeded`, {
          resultPath: "$.results",
          result: sfn.Result.fromObject({ message: "CodeBuild succeeded", success: true }),
        })
      )
      .when(
        sfn.Condition.stringEquals("$.CodeBuildGetBuilds.Builds[0].BuildStatus", "FAILED"),
        new sfn.Pass(this, `task-${applicationName}CodeBuildFailed`, {
          resultPath: "$.results",
          result: sfn.Result.fromObject({ message: "CodeBuild failed", success: false }),
        })
      )
      .otherwise(waitForCodeBuild);

    // Map on steps in stage
    const mapOnStepsInStage = new sfn.Map(this, "MapOnStepsInStage", {
      itemsPath: sfn.JsonPath.stringAt("$.iterator.currentStageSteps.steps"),
      resultPath: "$.iteratorResults",
    }).iterator(
      new sfn.Choice(this, "StepChoice", {
        comment: "Choice on step type, CodeBuild, CodePipeline, Human, Test, Notify, Wait",
      })
        .when(
          // These are the different deployment step types, CodeBuilds|CodePipelines|Humans|Tests|Notifications|Waits
          sfn.Condition.stringEquals("$.type", "CodeBuild"),
          new tasks.CallAwsService(this, `task-${applicationName}CodeBuildSync`, {
            service: "CodeBuild",
            // Wait for build to complete
            action: "startBuild",
            // integrationPattern: sfn.IntegrationPattern.RUN_JOB,
            parameters: {
              ProjectName: sfn.JsonPath.stringAt("$.codeBuildName"),
              // TODO: use States.JsonMerge to merge the environmentVariableOverrides in if optionlly provided
              // EnvironmentVariablesOverride: sfn.JsonPath.stringAt("$.value.environmentVariableOverrides"),
              SourceVersion: sfn.JsonPath.stringAt("$.sourceVersion"),
            },
            // This is used to grant the SFN permission to call the CodeBuilds
            iamResources: [...codeBuildArns],
            resultPath: "$.CodeBuildResults",
          }).next(waitForCodeBuild.next(checkCodeBuildComplete.next(codeBuildCompleteChoice)))
        )
        .when(
          // These are the different deployment step types, CodeBuilds|CodePipelines|Humans|Tests|Notifications|Waits
          sfn.Condition.stringEquals("$.type", "CodeBuildNoWait"),
          new tasks.CallAwsService(this, `task-${applicationName}CodeBuild`, {
            service: "CodeBuild",
            action: "startBuild",
            parameters: {
              ProjectName: sfn.JsonPath.stringAt("$.codeBuildName"),
              // TODO: use States.JsonMerge to merge the environmentVariableOverrides in if optionlly provided
              // EnvironmentVariablesOverride: sfn.JsonPath.stringAt("$.value.environmentVariableOverrides"),
              SourceVersion: sfn.JsonPath.stringAt("$.sourceVersion"),
            },
            iamResources: [...codeBuildArns],
          })
        )
        // .when(
        //   // These are the different deployment step types, CodeBuilds|CodePipelines|Humans|Tests|Notifications|Waits
        //   sfn.Condition.stringEquals("$.type", "CodePipeline"),
        //   new tasks.CallAwsService(this, `task-${applicationName}CodeBuild`, {
        //     service: "CodePipeline",
        //     action: "startPipelineExecution",
        //     parameters: {
        //       SourceVersion: sfn.JsonPath.stringAt("$.sourceVersion"),
        //     },
        //     iamResources: [...codeBuildArns],
        //   })
        // )
        // For Human step, publish the task token to an SNS topic then wait for a response
        .when(sfn.Condition.stringEquals("$.type", "Human"), humanConfirmationTask)
        // Notification step, send a notification to an SNS topic
        .when(
          sfn.Condition.stringEquals("$.type", "Notify"),
          new tasks.CallAwsService(this, `task-${applicationName}NotifyIterator`, {
            service: "SNS",
            action: "publish",
            parameters: { TopicArn: snsNotificationTopicArn, Message: sfn.JsonPath.stringAt("$.message") },
            iamResources: [snsNotificationTopicArn],
          })
        )
        // Wait step, wait for a specified amount of time
        .when(
          sfn.Condition.stringEquals("$.type", "Wait"),
          new sfn.Wait(this, `task-${applicationName}Wait`, {
            // Wait a time passed in on time
            time: sfn.WaitTime.secondsPath("$.seconds"),
          })
        )
    );

    // Choice on if deployment has exhausted all stages or should continue, either pass steps in stage into map or move to complete
    const choice = new sfn.Choice(this, "MoreStagesChoice", {
      comment:
        "Choice on if deployment has exhausted all stages or should continue, either pass steps in stage into map or move to complete",
    })
      .when(sfn.Condition.booleanEquals("$.iterator.continue", true), mapOnStepsInStage.next(steppyLambdaTask))
      .otherwise(completionNotificationTask);

    // Step Function tasks

    // Start by reading the input file, parsing it out and providing it as input to the state machine
    const stepMachineDefinition = readInputTask
      // Convert the JSON
      .next(convertInputTask)
      // Send a notification that deployment is beginning
      .next(startNotificationMessageTask)
      .next(notifyTask)
      // Pass to the Lambda that will increment the step and check if there are more steps, as well as returning this stage's steps
      .next(steppyLambdaTask)
      // From here either pass into the step iterator or complete based on the number of stages remaining
      .next(choice);

    const stateMachine = new sfn.StateMachine(this, `sfn-${applicationName}`, {
      definitionBody: sfn.DefinitionBody.fromChainable(stepMachineDefinition),
      stateMachineName: `sfn-${applicationName}-${stackSuffix}`,
      stateMachineType: sfn.StateMachineType.STANDARD,
      logs: loggingConfig,
      role: executionRole,
    });
  }
}
