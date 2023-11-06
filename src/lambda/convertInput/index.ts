export const handler = async (event: { input: string }, context: any, callback: any) => {
  const { input } = event;

  const inputParsed = JSON.parse(input);

  if (!inputParsed || !inputParsed.stages) throw new Error("Input invalid");

  const { stages } = inputParsed;

  return {
    stages,
    count: stages.length,
  };
};
