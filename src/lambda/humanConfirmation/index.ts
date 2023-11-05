import { SFNClient, SendTaskSuccessCommand, SendTaskFailureCommand } from "@aws-sdk/client-sfn";

const client = new SFNClient({ region: process.env.AWS_REGION || "ca-central-1" });

export const handler = (event: { queryStringParameters: { action: string; taskToken: string } }) => {
  console.log("event", event);

  const { queryStringParameters } = event;
  const { action, taskToken } = queryStringParameters;

  if (!action || !taskToken || !["approve", "reject"].includes(action)) {
    throw new Error("Invalid request");
  }

  const params = {
    cause: "Human approval",
    error: "Human approval",
    output: JSON.stringify({ action }),
    taskToken,
  };

  if (action === "approve") {
    client.send(new SendTaskSuccessCommand(params));
    return { statusCode: 200, body: "Success" };
  }

  client.send(new SendTaskFailureCommand(params));
  return { statusCode: 401, body: "Failure" };
};
