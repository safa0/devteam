import { CartesianGrid, Line, LineChart, XAxis } from "recharts";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  ChartConfig,
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
} from "@/components/ui/chart";
import { RefreshCcw } from "lucide-react";
import { Button } from "@/components/ui/button";

const formatNumber = (num: number): string => {
  if (num >= 1_000_000_000) {
    return (num / 1_000_000_000).toFixed(1).replace(/\.0$/, "") + "B";
  }
  if (num >= 1_000_000) {
    return (num / 1_000_000).toFixed(1).replace(/\.0$/, "") + "M";
  }
  if (num >= 1_000) {
    return (num / 1_000).toFixed(1).replace(/\.0$/, "") + "K";
  }
  return num.toString();
};

export function Usage({
  loading,
  onRefresh,
  data,
  totalTokens,
}: {
  data: { date: string; requests: number }[];
  totalTokens: number;
  loading: boolean;
  onRefresh: () => void;
}) {
  const chartConfig = {
    views: {
      label: "Requests",
    },
    requests: {
      label: "Requests",
      color: "var(--chart-1)",
    },
  } satisfies ChartConfig;

  return (
    <Card
      id="usage"
      className="py-4 sm:py-0 mt-2 shadow-none border border-border/70 rounded-xl"
    >
      <CardHeader className="flex flex-row items-stretch border-b !p-0 ">
        <div className="flex flex-row justify-between items-center">
          <div className="flex flex-1 flex-col justify-center gap-1 px-6 pb-0">
            <CardTitle className="text-md lg:text-lg">Freely Usage</CardTitle>
            <CardDescription className="text-xs lg:text-sm">
              Your current monthly usage of Freely's API
            </CardDescription>
          </div>

          <Button
            disabled={loading}
            variant="ghost"
            size="icon"
            onClick={onRefresh}
          >
            <RefreshCcw className={`size-4 ${loading ? "animate-spin" : ""}`} />
          </Button>
        </div>
        <div className="flex flex-1">
          {[
            {
              label: "Total Requests",
              value: data.reduce((acc, curr) => acc + curr.requests, 0),
            },
            {
              label: "Total Tokens",
              value: totalTokens,
            },
          ].map((key, index) => {
            return (
              <button
                key={index}
                className="flex flex-1 flex-col justify-center gap-1 border-t px-6 py-4 text-left even:border-l sm:border-t-0 sm:border-l sm:px-8 sm:py-6"
              >
                <span className="text-muted-foreground text-[10px] lg:text-xs">
                  {key.label}
                </span>
                <span className="text-lg lg:text-3xl leading-none font-bold">
                  {formatNumber(key.value)}
                </span>
              </button>
            );
          })}
        </div>
      </CardHeader>
      <CardContent className="px-2 sm:p-6">
        <ChartContainer
          config={chartConfig}
          className="aspect-auto h-[250px] w-full"
        >
          <LineChart
            accessibilityLayer
            data={data}
            margin={{
              left: 12,
              right: 12,
            }}
          >
            <CartesianGrid vertical={false} />
            <XAxis
              dataKey="date"
              tickLine={false}
              axisLine={false}
              tickMargin={8}
              minTickGap={32}
              tickFormatter={(value) => {
                const date = new Date(value);
                return date.toLocaleDateString("en-US", {
                  month: "short",
                  day: "numeric",
                });
              }}
            />
            <ChartTooltip
              content={
                <ChartTooltipContent
                  className="w-[150px]"
                  nameKey="views"
                  labelFormatter={(value) => {
                    return new Date(value).toLocaleDateString("en-US", {
                      month: "short",
                      day: "numeric",
                      year: "numeric",
                    });
                  }}
                />
              }
            />
            <Line
              dataKey="requests"
              type="monotone"
              stroke={`var(--color-requests)`}
              strokeWidth={2}
              dot={false}
            />
          </LineChart>
        </ChartContainer>
      </CardContent>
    </Card>
  );
}
