import { SNSClient, PublishCommand } from "@aws-sdk/client-sns"; // ES Modules import
const client = new SNSClient({ region: process.env.AWS_REGION || "ca-central-1" });

// Accepts a task token and a message, sends a notification to the user
export const handler = async (event: { taskToken: string; message: string }, context: any, callback: any) => {
  console.log("event", event);
  const { taskToken, message } = event;

  const confirmationLink = `${process.env.CONFIRMATION_URL}?taskToken=${encodeURIComponent(taskToken)}&action=approve`;
  console.log(`Confirmation link: ${confirmationLink}`);

  const params = {
    Message: `${message}\nTo continue the execution: ${confirmationLink} \nTo reject the execution: ${
      process.env.CONFIRMATION_URL
    }?taskToken=${encodeURIComponent(taskToken)}&action=reject`,
    TopicArn: process.env.SNS_TOPIC_ARN,
  };

  const command = new PublishCommand(params);

  try {
    const data = await client.send(command);
    console.log("Success", data);
    callback(null, data);
  } catch (err) {
    console.log("Error", err);
    callback(err);
  }
};
