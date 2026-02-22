import { Button, Card, CardContent, CardDescription, CardTitle } from "./ui";

const Contribute = () => {
  return (
    <Card className="w-full">
      <CardContent className="flex flex-col gap-4 p-4 py-0 md:flex-row md:items-center md:justify-between">
        <div className="space-y-2 md:max-w-[70%]">
          <CardTitle className="text-xs lg:text-sm">
            Contribute to Freely, Earn Lifetime Access
          </CardTitle>
          <CardDescription className="text-[10px] lg:text-xs">
            Fix a listed critical issue and earn a lifetime Dev Pro license
            valued at $120. Only issues on our contribute page qualify. read
            more at freely.app/contribute
          </CardDescription>
        </div>
        <Button asChild className="w-full md:w-auto text-[10px] lg:text-xs">
          <a
            href="https://freely.app/contribute"
            rel="noopener noreferrer"
            target="_blank"
          >
            freely.app/contribute
          </a>
        </Button>
      </CardContent>
    </Card>
  );
};

export default Contribute;
