import { Bazaar } from "./sections/Bazaar";
import { Footer, Header } from "./sections/Chrome";
import { Closing, FairAccess, Family } from "./sections/Closing";
import { Endpoints } from "./sections/Endpoints";
import { Faq } from "./sections/Faq";
import { GetKey } from "./sections/GetKey";
import { Hero } from "./sections/Hero";
import { HowItWorks } from "./sections/HowItWorks";
import { Quickstart } from "./sections/Quickstart";
import { UseCases } from "./sections/UseCases";
import { Why } from "./sections/Why";

/** The page: one document, its sections in the order the design has them. */
export function App() {
  return (
    <>
      <Header />
      <main id="top">
        <Hero />
        <Bazaar />
        <HowItWorks />
        <Why />
        <UseCases />
        <Quickstart />
        <Endpoints />
        <GetKey />
        <FairAccess />
        <Family />
        <Faq />
        <Closing />
      </main>
      <Footer />
    </>
  );
}
