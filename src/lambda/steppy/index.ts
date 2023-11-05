export const handler = (
  event: { iterator: { index: number; count: number }; stages: any[]; iteratorResults: any[] },
  context: any,
  callback: (arg0: null, iterator: { index: number; count: number; continue: boolean; currentStageSteps: any }) => void
) => {
  console.log(event);
  const { index, count } = event.iterator;
  const { stages } = event;
  const currentIndex = index + 1;
  const currentStageSteps = stages[currentIndex] || [];

  // Checking if the last stage had any failing steps, and throwing an error if so
  const lastStageResults = event.iteratorResults.filter((item) => item?.results?.success === false);
  if (lastStageResults.length > 0) {
    throw new Error("Last stage had failing steps");
  }

  // count - 1 because count is 1 based and index is 0 based
  callback(null, { index: currentIndex, count, continue: currentIndex < count, currentStageSteps });
};
